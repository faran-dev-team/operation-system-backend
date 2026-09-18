import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ContentJobStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { RecoveryScanSummary } from './durable-job.types';
import { DurableRetryService } from './durable-retry.service';

@Injectable()
export class DurableRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DurableRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly retryService: DurableRetryService,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log(
      'Executing startup recovery scan for stalled/orphaned jobs...',
    );
    try {
      const result = await this.recoverStalledJobs();
      if (result.scannedCount > 0) {
        this.logger.log(
          `Startup recovery scan finished: ${result.scannedCount} scanned, ${result.recoveredCount} recovered, ${result.deadLetteredCount} dead-lettered.`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Startup recovery scan encountered error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Scans for orphaned jobs whose lease expired while still marked as 'running'.
   * Reconciles them safely:
   * - If a draft already exists (meaning work completed before the worker process died), mark succeeded!
   * - Otherwise, route through retryService.handleFailure to back off or dead-letter.
   */
  async recoverStalledJobs(limit = 50): Promise<RecoveryScanSummary> {
    const now = new Date();

    const stalled = await this.prisma.db.generationJob.findMany({
      where: {
        status: ContentJobStatus.running,
        leaseExpiresAt: { lt: now },
      },
      include: {
        draft: true,
        contentRequest: true,
      },
      take: limit,
      orderBy: { leaseExpiresAt: 'asc' },
    });

    let recoveredCount = 0;
    let deadLetteredCount = 0;

    for (const job of stalled) {
      // Reconciliation: check if external outcome already completed (e.g. draft was created)
      if (job.draft) {
        await this.prisma.db.$transaction([
          this.prisma.db.generationJob.update({
            where: { id: job.id },
            data: {
              status: ContentJobStatus.succeeded,
              completedAt: now,
              leaseWorkerId: null,
              leaseExpiresAt: null,
              errorCode: null,
              errorMessage: null,
            },
          }),
          this.prisma.db.contentRequest.update({
            where: { id: job.contentRequestId },
            data: { status: ContentJobStatus.succeeded },
          }),
        ]);
        recoveredCount += 1;
        this.logger.log(
          `Reconciled stalled job ${job.id}: draft was already present. Marked succeeded without re-generating.`,
        );
        continue;
      }

      // No draft created yet -> route to retry or dead-letter
      const res = await this.retryService.handleFailure({
        jobId: job.id,
        workspaceId: job.workspaceId,
        errorCode: 'worker_lease_expired',
        errorMessage: 'Worker lease expired before job completion.',
      });

      if (res.action === 'retrying') {
        recoveredCount += 1;
      } else {
        deadLetteredCount += 1;
      }
    }

    return {
      scannedCount: stalled.length,
      recoveredCount,
      deadLetteredCount,
    };
  }
}
