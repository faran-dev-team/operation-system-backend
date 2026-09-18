import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContentJobStatus, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

import { requireWorkspaceRecord, workspaceWhere } from '../common/tenant';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateContentRequestDto } from './dto/create-content-request.dto';
import type { UpdateContentDraftDto } from './dto/update-content-draft.dto';
import {
  CONTENT_GENERATION_EXECUTOR,
  type ContentGenerationExecutor,
} from './generation/content-generation.executor';
import {
  CONTENT_PROMPT_VERSION,
  TEXT_GENERATION_PROVIDER,
  type TextGenerationProvider,
} from './generation/text-generation.types';

type RequestInput = {
  topic: string;
  audience?: string;
  format?: string;
};

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TEXT_GENERATION_PROVIDER)
    private readonly provider: TextGenerationProvider,
    @Inject(CONTENT_GENERATION_EXECUTOR)
    private readonly executor: ContentGenerationExecutor,
    private readonly audit: AuditService,
  ) {}

  async submit(
    workspaceId: string,
    userId: string,
    dto: CreateContentRequestDto,
    idempotencyKeyHeader?: string,
  ) {
    const idempotencyKey = this.resolveIdempotencyKey(
      dto.idempotencyKey,
      idempotencyKeyHeader,
      workspaceId,
      dto,
    );
    const input: RequestInput = {
      topic: dto.topic.trim(),
      audience: dto.audience?.trim() || undefined,
      format: dto.format?.trim() || undefined,
    };

    const existing = await this.findByIdempotencyKey(
      workspaceId,
      idempotencyKey,
    );
    if (existing) {
      return this.toSubmitResponse(
        existing.request,
        existing.job,
        existing.draft,
      );
    }

    const brand = await this.loadBrandContext(workspaceId);
    const { request, job } = await this.createRequestAndJob({
      workspaceId,
      userId,
      idempotencyKey,
      input,
      brandBriefId: brand?.id ?? null,
    });

    await this.audit.record({
      workspaceId,
      actorId: userId,
      action: 'content_request.submitted',
      resource: 'content_request',
      resourceId: request.id,
      payload: {
        topic: input.topic,
        audience: input.audience,
        format: input.format,
      },
    });

    await this.executor.execute({
      jobId: job.id,
      workspaceId,
      contentRequestId: request.id,
      topic: input.topic,
      audience: input.audience,
      format: input.format,
      operationId: job.operationId ?? undefined,
      brand: brand
        ? {
            name: brand.name,
            tone: brand.tone,
            approvedFacts: brand.approvedFacts,
            prohibitedClaims: brand.prohibitedClaims,
          }
        : null,
    });

    const refreshed = await this.waitForTerminalBundle(workspaceId, request.id);
    if (!refreshed) {
      throw new NotFoundException('Content request was not found.');
    }

    return this.toSubmitResponse(
      refreshed.request,
      refreshed.job,
      refreshed.draft,
    );
  }

  async getJob(workspaceId: string, jobId: string) {
    const job = await this.prisma.db.generationJob.findFirst({
      where: { id: jobId, ...workspaceWhere(workspaceId) },
      include: { draft: true },
    });
    const record = requireWorkspaceRecord(job, workspaceId);
    return this.serializeJob(record, record.draft);
  }

  async getDraft(workspaceId: string, draftId: string) {
    const draft = await this.prisma.db.contentDraft.findFirst({
      where: { id: draftId, ...workspaceWhere(workspaceId) },
    });
    return this.serializeDraft(requireWorkspaceRecord(draft, workspaceId));
  }

  async listDrafts(workspaceId: string) {
    const drafts = await this.prisma.db.contentDraft.findMany({
      where: workspaceWhere(workspaceId),
      orderBy: { createdAt: 'desc' },
    });
    return drafts.map((draft) => this.serializeDraft(draft));
  }

  /**
   * Optimistic-concurrency update: the WHERE clause pins both the tenant and
   * the expected version in a single UPDATE, so Postgres serializes
   * concurrent writers on the row lock and only one can ever match. A
   * mismatch (count === 0) is resolved into 404 vs 409 by re-checking
   * existence within the same workspace, without a second write.
   */
  async updateDraftContent(
    workspaceId: string,
    userId: string,
    draftId: string,
    dto: UpdateContentDraftDto,
  ) {
    const content = dto.content.trim();
    if (!content) {
      throw new BadRequestException('content must not be empty.');
    }

    const updateResult = await this.prisma.db.contentDraft.updateMany({
      where: {
        id: draftId,
        workspaceId,
        version: dto.expectedVersion,
      },
      data: {
        body: content,
        version: { increment: 1 },
      },
    });

    if (updateResult.count === 0) {
      const existing = await this.prisma.db.contentDraft.findFirst({
        where: { id: draftId, workspaceId },
        select: { version: true },
      });

      if (!existing) {
        throw new NotFoundException('Record was not found in this workspace.');
      }

      throw new ConflictException(
        `Draft version is stale. Expected version ${dto.expectedVersion}, current version is ${existing.version}.`,
      );
    }

    const updated = requireWorkspaceRecord(
      await this.prisma.db.contentDraft.findFirst({
        where: { id: draftId, ...workspaceWhere(workspaceId) },
      }),
      workspaceId,
    );

    await this.audit.record({
      workspaceId,
      actorId: userId,
      action: 'content_draft.updated',
      resource: 'content_draft',
      resourceId: draftId,
      payload: {
        previousVersion: dto.expectedVersion,
        newVersion: updated.version,
      },
    });

    return this.serializeDraft(updated);
  }

  private resolveIdempotencyKey(
    bodyKey: string | undefined,
    headerKey: string | undefined,
    workspaceId: string,
    dto: CreateContentRequestDto,
  ) {
    const fromHeader = headerKey?.trim();
    const fromBody = bodyKey?.trim();

    if (fromHeader && fromBody && fromHeader !== fromBody) {
      throw new BadRequestException(
        'Idempotency-Key header and body idempotencyKey must match when both are provided.',
      );
    }

    const provided = fromHeader || fromBody;
    if (provided) {
      return provided.slice(0, 128);
    }
    return createHash('sha256')
      .update(
        JSON.stringify({
          workspaceId,
          topic: dto.topic.trim(),
          audience: dto.audience?.trim() ?? null,
          format: dto.format?.trim() ?? null,
          nonce: randomUUID(),
        }),
      )
      .digest('hex')
      .slice(0, 64);
  }

  private async findByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
  ) {
    const request = await this.prisma.db.contentRequest.findFirst({
      where: { workspaceId, idempotencyKey },
      include: {
        generationJobs: { include: { draft: true }, take: 1 },
        drafts: { take: 1 },
      },
    });
    if (!request) {
      return null;
    }
    const job = request.generationJobs[0] ?? null;
    const draft = job?.draft ?? request.drafts[0] ?? null;
    return { request, job, draft };
  }

  private async createRequestAndJob(params: {
    workspaceId: string;
    userId: string;
    idempotencyKey: string;
    input: RequestInput;
    brandBriefId: string | null;
  }) {
    try {
      return await this.prisma.db.$transaction(async (tx) => {
        const request = await tx.contentRequest.create({
          data: {
            workspaceId: params.workspaceId,
            createdByUserId: params.userId,
            brandBriefId: params.brandBriefId,
            status: ContentJobStatus.requested,
            prompt: params.input.topic,
            input: params.input,
            idempotencyKey: params.idempotencyKey,
          },
        });

        const operationId = createHash('sha256')
          .update(
            `${params.workspaceId}:${request.id}:${CONTENT_PROMPT_VERSION}`,
          )
          .digest('hex');

        const job = await tx.generationJob.create({
          data: {
            workspaceId: params.workspaceId,
            contentRequestId: request.id,
            status: ContentJobStatus.requested,
            provider: this.provider.name,
            promptVersion: CONTENT_PROMPT_VERSION,
            operationId,
            retryCount: 0,
            maxRetries: 3,
          },
        });

        return { request, job };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.findByIdempotencyKey(
          params.workspaceId,
          params.idempotencyKey,
        );
        if (existing?.request && existing.job) {
          return { request: existing.request, job: existing.job };
        }
        throw new ConflictException(
          'A content request with this idempotency key already exists.',
        );
      }
      throw error;
    }
  }

  private loadBrandContext(workspaceId: string) {
    return this.prisma.db.brandBrief.findUnique({
      where: { workspaceId },
    });
  }

  private async loadBundle(workspaceId: string, contentRequestId: string) {
    const request = await this.prisma.db.contentRequest.findFirst({
      where: { id: contentRequestId, workspaceId },
      include: {
        generationJobs: { include: { draft: true }, take: 1 },
        drafts: { take: 1 },
      },
    });
    if (!request) {
      return null;
    }
    return {
      request,
      job: request.generationJobs[0] ?? null,
      draft: request.generationJobs[0]?.draft ?? request.drafts[0] ?? null,
    };
  }

  private async waitForTerminalBundle(
    workspaceId: string,
    contentRequestId: string,
  ) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const bundle = await this.loadBundle(workspaceId, contentRequestId);
      if (!bundle) {
        return null;
      }
      const status = bundle.job?.status;
      if (
        status === ContentJobStatus.succeeded ||
        status === ContentJobStatus.failed ||
        !status
      ) {
        return bundle;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.loadBundle(workspaceId, contentRequestId);
  }

  private toSubmitResponse(
    request: {
      id: string;
      workspaceId: string;
      createdByUserId: string | null;
      status: ContentJobStatus;
      input: Prisma.JsonValue;
      idempotencyKey: string | null;
      createdAt: Date;
    },
    job: {
      id: string;
      workspaceId: string;
      contentRequestId: string;
      status: ContentJobStatus;
      provider: string;
      promptVersion: string;
      errorCode: string | null;
      errorMessage: string | null;
      startedAt: Date | null;
      completedAt: Date | null;
      usageMetadata: Prisma.JsonValue;
      createdAt: Date;
      updatedAt: Date;
    } | null,
    draft: {
      id: string;
      workspaceId: string;
      contentRequestId: string;
      generationJobId: string | null;
      title: string | null;
      body: string;
      version: number;
      provider: string | null;
      promptVersion: string | null;
      metadata: Prisma.JsonValue;
      createdAt: Date;
      updatedAt: Date;
    } | null,
  ) {
    return {
      request: {
        id: request.id,
        workspaceId: request.workspaceId,
        createdByUserId: request.createdByUserId,
        status: request.status,
        input: request.input,
        idempotencyKey: request.idempotencyKey,
        createdAt: request.createdAt,
      },
      job: job ? this.serializeJob(job, draft) : null,
      draft: draft ? this.serializeDraft(draft) : null,
    };
  }

  private serializeJob(
    job: {
      id: string;
      workspaceId: string;
      contentRequestId: string;
      status: ContentJobStatus;
      provider: string;
      promptVersion: string;
      errorCode: string | null;
      errorMessage: string | null;
      startedAt: Date | null;
      completedAt: Date | null;
      usageMetadata: Prisma.JsonValue;
      createdAt: Date;
      updatedAt: Date;
    },
    draft?: { id: string } | null,
  ) {
    return {
      id: job.id,
      workspaceId: job.workspaceId,
      contentRequestId: job.contentRequestId,
      status: job.status,
      provider: job.provider,
      promptVersion: job.promptVersion,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      usageMetadata: job.usageMetadata,
      draftId: draft?.id ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private serializeDraft(draft: {
    id: string;
    workspaceId: string;
    contentRequestId: string;
    generationJobId: string | null;
    title: string | null;
    body: string;
    version: number;
    provider: string | null;
    promptVersion: string | null;
    metadata: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: draft.id,
      workspaceId: draft.workspaceId,
      contentRequestId: draft.contentRequestId,
      generationJobId: draft.generationJobId,
      title: draft.title,
      body: draft.body,
      version: draft.version,
      provider: draft.provider,
      promptVersion: draft.promptVersion,
      metadata: draft.metadata,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    };
  }
}
