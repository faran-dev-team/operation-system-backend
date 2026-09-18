import { Injectable, Logger } from '@nestjs/common';
import { ContentJobStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { FailureHandlingResult } from './durable-job.types';

@Injectable()
export class DurableRetryService {
  private readonly logger = new Logger(DurableRetryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Computes exponential backoff with jitter:
   * delay = min(maxDelayMs, baseDelayMs * 2^(attempt - 1)) + jitter
   */
  computeBackoff(
    attempt: number,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
  ): number {
    const exp = Math.min(attempt - 1, 10);
    const delay = Math.min(baseDelayMs * Math.pow(2, exp), maxDelayMs);
    const jitter = Math.floor(Math.random() * (delay * 0.1));
    return delay + jitter;
  }

  /**
   * Handles failure for a job:
   * If retryCount + 1 < maxRetries -> increments retryCount, calculates nextRetryAt, resets status to 'requested', releases lease.
   * If retryCount + 1 >= maxRetries -> marks status 'failed', sets deadLetteredAt = now, deadLetterReason.
   */
  async handleFailure(params: {
    jobId: string;
    workspaceId: string;
    errorCode?: string;
    errorMessage: string;
    baseDelayMs?: number;
    maxDelayMs?: number;
  }): Promise<FailureHandlingResult> {
    const job = await this.prisma.db.generationJob.findFirst({
      where: { id: params.jobId, workspaceId: params.workspaceId },
      select: { retryCount: true, maxRetries: true },
    });

    if (!job) {
      return {
        action: 'dead_lettered',
        deadLetteredAt: new Date(),
        reason: 'Job not found',
      };
    }

    const nextAttempt = job.retryCount + 1;
    const now = new Date();

    if (nextAttempt < job.maxRetries) {
      const backoffMs = this.computeBackoff(
        nextAttempt,
        params.baseDelayMs,
        params.maxDelayMs,
      );
      const nextRetryAt = new Date(now.getTime() + backoffMs);

      await this.prisma.db.generationJob.update({
        where: { id: params.jobId },
        data: {
          status: ContentJobStatus.requested,
          retryCount: nextAttempt,
          nextRetryAt,
          leaseWorkerId: null,
          leaseExpiresAt: null,
          errorCode: params.errorCode ?? 'retryable_failure',
          errorMessage: params.errorMessage,
        },
      });

      this.logger.warn(
        `Job ${params.jobId} failed (attempt ${nextAttempt}/${job.maxRetries}). Backoff until ${nextRetryAt.toISOString()}`,
      );

      return {
        action: 'retrying',
        nextRetryAt,
        retryCount: nextAttempt,
      };
    }

    // Dead letter
    await this.prisma.db.generationJob.update({
      where: { id: params.jobId },
      data: {
        status: ContentJobStatus.failed,
        retryCount: nextAttempt,
        leaseWorkerId: null,
        leaseExpiresAt: null,
        deadLetteredAt: now,
        deadLetterReason: params.errorMessage,
        errorCode: params.errorCode ?? 'max_retries_exceeded',
        errorMessage: params.errorMessage,
      },
    });

    this.logger.error(
      `Job ${params.jobId} reached max retries (${job.maxRetries}). Dead-lettered. Reason: ${params.errorMessage}`,
    );

    return {
      action: 'dead_lettered',
      deadLetteredAt: now,
      reason: params.errorMessage,
    };
  }
}
