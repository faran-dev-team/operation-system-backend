import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ContentJobStatus, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

import { DurableLeaseService } from '../../jobs/durable/durable-lease.service';
import { DurableRetryService } from '../../jobs/durable/durable-retry.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CONTENT_PROMPT_VERSION,
  GenerationProviderError,
  TEXT_GENERATION_PROVIDER,
  type BrandContext,
  type TextGenerationProvider,
} from './text-generation.types';

export type GenerationJobExecutionInput = {
  jobId: string;
  workspaceId: string;
  contentRequestId: string;
  topic: string;
  audience?: string;
  format?: string;
  brand?: BrandContext | null;
  workerId?: string;
  operationId?: string;
};

export interface ContentGenerationExecutor {
  execute(input: GenerationJobExecutionInput): Promise<{
    status: ContentJobStatus;
    draftId?: string;
    errorCode?: string;
    errorMessage?: string;
  }>;
}

export const CONTENT_GENERATION_EXECUTOR = Symbol(
  'CONTENT_GENERATION_EXECUTOR',
);

@Injectable()
export class DefaultContentGenerationExecutor implements ContentGenerationExecutor {
  private readonly logger = new Logger(DefaultContentGenerationExecutor.name);
  private readonly leaseService: DurableLeaseService;
  private readonly retryService: DurableRetryService;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(TEXT_GENERATION_PROVIDER)
    private readonly provider: TextGenerationProvider,
    @Optional()
    leaseService?: DurableLeaseService,
    @Optional()
    retryService?: DurableRetryService,
  ) {
    this.leaseService = leaseService ?? new DurableLeaseService(prisma);
    this.retryService = retryService ?? new DurableRetryService(prisma);
  }

  async execute(input: GenerationJobExecutionInput) {
    const operationId =
      input.operationId ??
      createHash('sha256')
        .update(
          `${input.workspaceId}:${input.contentRequestId}:${CONTENT_PROMPT_VERSION}`,
        )
        .digest('hex');

    // 1. External State Reconciliation: Check if draft was already created
    const existingDraft = await this.prisma.db.contentDraft.findFirst({
      where: {
        contentRequestId: input.contentRequestId,
        workspaceId: input.workspaceId,
      },
    });

    if (existingDraft) {
      this.logger.log(
        `Job ${input.jobId} already has draft ${existingDraft.id}. Reconciling without regenerating.`,
      );
      await this.prisma.db.$transaction(async (tx) => {
        await tx.generationJob.update({
          where: { id: input.jobId },
          data: {
            status: ContentJobStatus.succeeded,
            completedAt: new Date(),
            leaseWorkerId: null,
            leaseExpiresAt: null,
            errorCode: null,
            errorMessage: null,
          },
        });
        await tx.contentRequest.update({
          where: { id: input.contentRequestId },
          data: { status: ContentJobStatus.succeeded },
        });
      });

      return {
        status: ContentJobStatus.succeeded,
        draftId: existingDraft.id,
      };
    }

    // 2. Atomic Lease Acquisition
    const workerId =
      input.workerId ?? this.leaseService.createWorkerId('content-gen');
    const lease = await this.leaseService.acquireLease({
      jobId: input.jobId,
      workspaceId: input.workspaceId,
      workerId,
      ttlSeconds: 60,
    });

    if (!lease.acquired) {
      const existing = await this.prisma.db.generationJob.findFirst({
        where: { id: input.jobId, workspaceId: input.workspaceId },
        include: { draft: true },
      });

      return {
        status: existing?.status ?? ContentJobStatus.failed,
        draftId: existing?.draft?.id,
        errorCode: existing?.errorCode ?? undefined,
        errorMessage: existing?.errorMessage ?? undefined,
      };
    }

    // Ensure operationId is stored on the job record
    await this.prisma.db.generationJob.updateMany({
      where: { id: input.jobId, operationId: null },
      data: { operationId },
    });

    await this.prisma.db.contentRequest.updateMany({
      where: { id: input.contentRequestId, workspaceId: input.workspaceId },
      data: { status: ContentJobStatus.running },
    });

    // 3. Execution with bounded retry and reconciliation
    try {
      const result = await this.provider.generate({
        topic: input.topic,
        audience: input.audience,
        format: input.format,
        brand: input.brand,
        workspaceId: input.workspaceId,
        contentRequestId: input.contentRequestId,
      });

      const draft = await this.prisma.db.$transaction(async (tx) => {
        const created = await tx.contentDraft.upsert({
          where: { contentRequestId: input.contentRequestId },
          create: {
            workspaceId: input.workspaceId,
            contentRequestId: input.contentRequestId,
            generationJobId: input.jobId,
            title: result.title,
            body: result.body,
            version: 1,
            provider: result.provider,
            promptVersion: result.promptVersion,
            metadata: (result.metadata ?? {}) as Prisma.InputJsonValue,
          },
          update: {
            generationJobId: input.jobId,
            title: result.title,
            body: result.body,
            provider: result.provider,
            promptVersion: result.promptVersion,
            metadata: (result.metadata ?? {}) as Prisma.InputJsonValue,
          },
        });

        await tx.generationJob.update({
          where: { id: input.jobId },
          data: {
            status: ContentJobStatus.succeeded,
            completedAt: new Date(),
            leaseWorkerId: null,
            leaseExpiresAt: null,
            usageMetadata: (result.usage ??
              Prisma.JsonNull) as Prisma.InputJsonValue,
            errorCode: null,
            errorMessage: null,
          },
        });

        await tx.contentRequest.update({
          where: { id: input.contentRequestId },
          data: { status: ContentJobStatus.succeeded },
        });

        return created;
      });

      return {
        status: ContentJobStatus.succeeded,
        draftId: draft.id,
      };
    } catch (error) {
      const safe =
        error instanceof GenerationProviderError
          ? error.toSafeError()
          : {
              code: 'generation_failed',
              message: 'Content generation failed.',
            };

      this.logger.warn(
        `Generation job ${input.jobId} failed with code ${safe.code}: ${safe.message}`,
      );

      const job = await this.prisma.db.generationJob.findFirst({
        where: { id: input.jobId },
        select: { retryCount: true, maxRetries: true },
      });

      const nextRetryCount = (job?.retryCount ?? 0) + 1;
      const isDeadLetter = nextRetryCount >= (job?.maxRetries ?? 3);

      await this.prisma.db.$transaction(async (tx) => {
        await tx.generationJob.update({
          where: { id: input.jobId },
          data: {
            status: ContentJobStatus.failed,
            completedAt: new Date(),
            leaseWorkerId: null,
            leaseExpiresAt: null,
            errorCode: safe.code,
            errorMessage: safe.message,
            retryCount: nextRetryCount,
            deadLetteredAt: isDeadLetter ? new Date() : null,
            deadLetterReason: isDeadLetter ? safe.message : null,
          },
        });
        await tx.contentRequest.update({
          where: { id: input.contentRequestId },
          data: { status: ContentJobStatus.failed },
        });
      });

      return {
        status: ContentJobStatus.failed,
        errorCode: safe.code,
        errorMessage: safe.message,
      };
    }
  }
}
