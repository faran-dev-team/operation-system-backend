import { Injectable, Logger } from '@nestjs/common';
import { ContentJobStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import type { LeaseAcquisitionResult } from './durable-job.types';

@Injectable()
export class DurableLeaseService {
  private readonly logger = new Logger(DurableLeaseService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generates a stable worker ID for this instance / process.
   */
  createWorkerId(prefix = 'worker'): string {
    return `${prefix}-${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Atomically acquires an execution lease on a job if:
   * 1. status is 'requested' AND (nextRetryAt IS NULL OR nextRetryAt <= NOW())
   * OR
   * 2. status is 'running' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt < NOW() (recovered lease)
   */
  async acquireLease(params: {
    jobId: string;
    workspaceId: string;
    workerId: string;
    ttlSeconds?: number;
  }): Promise<LeaseAcquisitionResult> {
    const ttlSeconds = params.ttlSeconds ?? 60;
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const updated = await this.prisma.db.generationJob.updateMany({
      where: {
        id: params.jobId,
        workspaceId: params.workspaceId,
        OR: [
          {
            status: ContentJobStatus.requested,
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
          },
          {
            status: ContentJobStatus.running,
            leaseExpiresAt: { lt: now },
          },
        ],
      },
      data: {
        status: ContentJobStatus.running,
        leaseWorkerId: params.workerId,
        leaseExpiresAt,
        startedAt: now,
      },
    });

    if (updated.count > 0) {
      return {
        acquired: true,
        workerId: params.workerId,
        leaseExpiresAt,
      };
    }

    const existing = await this.prisma.db.generationJob.findFirst({
      where: { id: params.jobId, workspaceId: params.workspaceId },
      select: { status: true, nextRetryAt: true, leaseExpiresAt: true },
    });

    if (!existing) {
      return { acquired: false, reason: 'not_found' };
    }

    if (
      existing.status === ContentJobStatus.succeeded ||
      existing.status === ContentJobStatus.failed
    ) {
      return { acquired: false, reason: 'already_completed' };
    }

    if (existing.nextRetryAt && existing.nextRetryAt > now) {
      return { acquired: false, reason: 'backoff_active' };
    }

    return { acquired: false, reason: 'already_running' };
  }

  /**
   * Heartbeat to extend the lease while execution is actively continuing.
   */
  async renewLease(params: {
    jobId: string;
    workspaceId: string;
    workerId: string;
    extensionSeconds?: number;
  }): Promise<boolean> {
    const extensionSeconds = params.extensionSeconds ?? 60;
    const now = new Date();
    const newLeaseExpiresAt = new Date(now.getTime() + extensionSeconds * 1000);

    const updated = await this.prisma.db.generationJob.updateMany({
      where: {
        id: params.jobId,
        workspaceId: params.workspaceId,
        status: ContentJobStatus.running,
        leaseWorkerId: params.workerId,
      },
      data: {
        leaseExpiresAt: newLeaseExpiresAt,
      },
    });

    return updated.count > 0;
  }

  /**
   * Releases lease when job is finished or abandoned.
   */
  async releaseLease(params: {
    jobId: string;
    workspaceId: string;
    workerId: string;
  }): Promise<void> {
    await this.prisma.db.generationJob.updateMany({
      where: {
        id: params.jobId,
        workspaceId: params.workspaceId,
        leaseWorkerId: params.workerId,
      },
      data: {
        leaseWorkerId: null,
        leaseExpiresAt: null,
      },
    });
  }
}
