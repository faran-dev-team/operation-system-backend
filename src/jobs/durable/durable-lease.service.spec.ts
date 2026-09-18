import { ContentJobStatus } from '@prisma/client';

import { DurableLeaseService } from './durable-lease.service';
import { DurableRecoveryService } from './durable-recovery.service';
import { DurableRetryService } from './durable-retry.service';

describe('Durable Background Jobs Subsystem', () => {
  let prismaMock: any;
  let leaseService: DurableLeaseService;
  let retryService: DurableRetryService;
  let recoveryService: DurableRecoveryService;

  beforeEach(() => {
    prismaMock = {
      db: {
        generationJob: {
          updateMany: jest.fn(),
          findFirst: jest.fn(),
          update: jest.fn(),
          findMany: jest.fn(),
        },
        contentRequest: {
          update: jest.fn(),
        },
        $transaction: jest.fn((actions) => Promise.all(actions)),
      },
    };

    leaseService = new DurableLeaseService(prismaMock);
    retryService = new DurableRetryService(prismaMock);
    recoveryService = new DurableRecoveryService(prismaMock, retryService);
  });

  describe('DurableLeaseService', () => {
    it('generates unique worker IDs with the requested prefix', () => {
      const w1 = leaseService.createWorkerId('content');
      const w2 = leaseService.createWorkerId('content');
      expect(w1).toContain('content-');
      expect(w2).toContain('content-');
      expect(w1).not.toBe(w2);
    });

    it('acquires lease successfully when job is requested or expired', async () => {
      prismaMock.db.generationJob.updateMany.mockResolvedValue({ count: 1 });

      const result = await leaseService.acquireLease({
        jobId: 'job-1',
        workspaceId: 'ws-1',
        workerId: 'worker-1',
        ttlSeconds: 45,
      });

      expect(result.acquired).toBe(true);
      if (result.acquired) {
        expect(result.workerId).toBe('worker-1');
        expect(result.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
      }
      expect(prismaMock.db.generationJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'job-1',
            workspaceId: 'ws-1',
          }),
        }),
      );
    });

    it('rejects acquisition when job is already running and lease is active', async () => {
      prismaMock.db.generationJob.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.db.generationJob.findFirst.mockResolvedValue({
        status: ContentJobStatus.running,
        leaseExpiresAt: new Date(Date.now() + 30000),
      });

      const result = await leaseService.acquireLease({
        jobId: 'job-1',
        workspaceId: 'ws-1',
        workerId: 'worker-2',
      });

      expect(result.acquired).toBe(false);
      if (!result.acquired) {
        expect(result.reason).toBe('already_running');
      }
    });

    it('rejects acquisition when job is already completed', async () => {
      prismaMock.db.generationJob.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.db.generationJob.findFirst.mockResolvedValue({
        status: ContentJobStatus.succeeded,
      });

      const result = await leaseService.acquireLease({
        jobId: 'job-1',
        workspaceId: 'ws-1',
        workerId: 'worker-1',
      });

      expect(result.acquired).toBe(false);
      if (!result.acquired) {
        expect(result.reason).toBe('already_completed');
      }
    });

    it('rejects acquisition when retry backoff is still active', async () => {
      prismaMock.db.generationJob.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.db.generationJob.findFirst.mockResolvedValue({
        status: ContentJobStatus.requested,
        nextRetryAt: new Date(Date.now() + 10000),
      });

      const result = await leaseService.acquireLease({
        jobId: 'job-1',
        workspaceId: 'ws-1',
        workerId: 'worker-1',
      });

      expect(result.acquired).toBe(false);
      if (!result.acquired) {
        expect(result.reason).toBe('backoff_active');
      }
    });

    it('renews lease for the owning worker', async () => {
      prismaMock.db.generationJob.updateMany.mockResolvedValue({ count: 1 });

      const renewed = await leaseService.renewLease({
        jobId: 'job-1',
        workspaceId: 'ws-1',
        workerId: 'worker-1',
        extensionSeconds: 60,
      });

      expect(renewed).toBe(true);
      expect(prismaMock.db.generationJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'job-1',
            status: ContentJobStatus.running,
            leaseWorkerId: 'worker-1',
          }),
        }),
      );
    });

    it('releases lease properly', async () => {
      prismaMock.db.generationJob.updateMany.mockResolvedValue({ count: 1 });

      await leaseService.releaseLease({
        jobId: 'job-1',
        workspaceId: 'ws-1',
        workerId: 'worker-1',
      });

      expect(prismaMock.db.generationJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            leaseWorkerId: null,
            leaseExpiresAt: null,
          },
        }),
      );
    });
  });

  describe('DurableRetryService', () => {
    it('computes exponential backoff bounded within range', () => {
      const d1 = retryService.computeBackoff(1, 1000, 30000);
      const d2 = retryService.computeBackoff(2, 1000, 30000);
      const d3 = retryService.computeBackoff(3, 1000, 30000);

      expect(d1).toBeGreaterThanOrEqual(1000);
      expect(d2).toBeGreaterThanOrEqual(2000);
      expect(d3).toBeGreaterThanOrEqual(4000);
      expect(d1).toBeLessThan(d2);
      expect(d2).toBeLessThan(d3);
    });

    it('schedules retry when retryCount is within maxRetries limit', async () => {
      prismaMock.db.generationJob.findFirst.mockResolvedValue({
        retryCount: 1,
        maxRetries: 3,
      });
      prismaMock.db.generationJob.update.mockResolvedValue({});

      const result = await retryService.handleFailure({
        jobId: 'job-1',
        workspaceId: 'ws-1',
        errorMessage: 'Network timeout',
      });

      expect(result.action).toBe('retrying');
      if (result.action === 'retrying') {
        expect(result.retryCount).toBe(2);
        expect(result.nextRetryAt.getTime()).toBeGreaterThan(Date.now());
      }
      expect(prismaMock.db.generationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-1' },
          data: expect.objectContaining({
            status: ContentJobStatus.requested,
            retryCount: 2,
            leaseWorkerId: null,
            leaseExpiresAt: null,
          }),
        }),
      );
    });

    it('dead-letters job when retryCount reaches maxRetries', async () => {
      prismaMock.db.generationJob.findFirst.mockResolvedValue({
        retryCount: 2,
        maxRetries: 3,
      });
      prismaMock.db.generationJob.update.mockResolvedValue({});

      const result = await retryService.handleFailure({
        jobId: 'job-1',
        workspaceId: 'ws-1',
        errorMessage: 'Permanent error',
      });

      expect(result.action).toBe('dead_lettered');
      if (result.action === 'dead_lettered') {
        expect(result.reason).toBe('Permanent error');
      }
      expect(prismaMock.db.generationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-1' },
          data: expect.objectContaining({
            status: ContentJobStatus.failed,
            retryCount: 3,
            deadLetterReason: 'Permanent error',
            leaseWorkerId: null,
            leaseExpiresAt: null,
          }),
        }),
      );
    });
  });

  describe('DurableRecoveryService', () => {
    it('reconciles stalled jobs without regenerating if draft is already present', async () => {
      prismaMock.db.generationJob.findMany.mockResolvedValue([
        {
          id: 'job-stalled-1',
          workspaceId: 'ws-1',
          contentRequestId: 'req-1',
          draft: { id: 'draft-1' },
          contentRequest: { id: 'req-1' },
        },
      ]);
      prismaMock.db.generationJob.update.mockResolvedValue({});
      prismaMock.db.contentRequest.update.mockResolvedValue({});

      const summary = await recoveryService.recoverStalledJobs();

      expect(summary.scannedCount).toBe(1);
      expect(summary.recoveredCount).toBe(1);
      expect(summary.deadLetteredCount).toBe(0);
      expect(prismaMock.db.generationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-stalled-1' },
          data: expect.objectContaining({
            status: ContentJobStatus.succeeded,
            leaseWorkerId: null,
            leaseExpiresAt: null,
          }),
        }),
      );
    });

    it('reschedules stalled jobs for retry if no draft was created', async () => {
      prismaMock.db.generationJob.findMany.mockResolvedValue([
        {
          id: 'job-stalled-2',
          workspaceId: 'ws-1',
          contentRequestId: 'req-2',
          draft: null,
          contentRequest: { id: 'req-2' },
        },
      ]);
      prismaMock.db.generationJob.findFirst.mockResolvedValue({
        retryCount: 0,
        maxRetries: 3,
      });
      prismaMock.db.generationJob.update.mockResolvedValue({});

      const summary = await recoveryService.recoverStalledJobs();

      expect(summary.scannedCount).toBe(1);
      expect(summary.recoveredCount).toBe(1);
      expect(summary.deadLetteredCount).toBe(0);
    });
  });
});
