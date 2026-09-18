import type { ContentJobStatus } from '@prisma/client';

export type LeaseAcquisitionResult =
  | { acquired: true; workerId: string; leaseExpiresAt: Date }
  | {
      acquired: false;
      reason:
        | 'already_running'
        | 'already_completed'
        | 'not_found'
        | 'backoff_active';
    };

export type FailureHandlingResult =
  | { action: 'retrying'; nextRetryAt: Date; retryCount: number }
  | { action: 'dead_lettered'; deadLetteredAt: Date; reason: string };

export type RecoveryScanSummary = {
  scannedCount: number;
  recoveredCount: number;
  deadLetteredCount: number;
};

export type DurableJobSummary = {
  id: string;
  workspaceId: string;
  status: ContentJobStatus;
  retryCount: number;
  maxRetries: number;
  operationId: string | null;
  leaseWorkerId: string | null;
  leaseExpiresAt: Date | null;
  nextRetryAt: Date | null;
  deadLetteredAt: Date | null;
  deadLetterReason: string | null;
};
