import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ContentJobStatus } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import {
  CONTENT_GENERATION_EXECUTOR,
  DefaultContentGenerationExecutor,
} from '../src/content/generation/content-generation.executor';
import { StubTextGenerationProvider } from '../src/content/generation/stub-text-generation.provider';
import {
  CONTENT_PROMPT_VERSION,
  TEXT_GENERATION_PROVIDER,
  type TextGenerationProvider,
} from '../src/content/generation/text-generation.types';
import { DurableLeaseService } from '../src/jobs/durable/durable-lease.service';
import { DurableRecoveryService } from '../src/jobs/durable/durable-recovery.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SupabaseService } from '../src/supabase/supabase.service';

const TEST_TOKEN = 'durable-test-token';
const TEST_EMAIL = 'operator.alpha@pilot.local';

describe('Durable background-jobs & worker resilience (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let leaseService: DurableLeaseService;
  let recoveryService: DurableRecoveryService;
  let executor: DefaultContentGenerationExecutor;
  let workspaceId: string;
  let userId: string;
  const createdRequestIds: string[] = [];

  const mockProviderGenerate = jest.fn();

  beforeAll(async () => {
    const mockProvider: TextGenerationProvider = {
      name: 'stub',
      generate: mockProviderGenerate,
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue({
        check: () => Promise.resolve('ok'),
        getUserFromAccessToken: (token: string) => {
          if (token === TEST_TOKEN) {
            return Promise.resolve({
              id: 'sb-auth-alpha',
              email: TEST_EMAIL,
            });
          }
          return Promise.resolve(null);
        },
      })
      .overrideProvider(TEXT_GENERATION_PROVIDER)
      .useValue(mockProvider)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    leaseService = app.get(DurableLeaseService);
    recoveryService = app.get(DurableRecoveryService);
    executor = app.get(
      CONTENT_GENERATION_EXECUTOR,
    ) as DefaultContentGenerationExecutor;

    const user = await prisma.db.user.findUnique({
      where: { email: TEST_EMAIL },
    });
    const workspace = await prisma.db.workspace.findUnique({
      where: { slug: 'pilot-alpha' },
    });

    if (!user || !workspace) {
      throw new Error(
        'Database seed missing pilot-alpha workspace or operator.alpha user.',
      );
    }

    userId = user.id;
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    if (createdRequestIds.length > 0) {
      await prisma.db.contentDraft.deleteMany({
        where: { contentRequestId: { in: createdRequestIds } },
      });
      await prisma.db.generationJob.deleteMany({
        where: { contentRequestId: { in: createdRequestIds } },
      });
      await prisma.db.contentRequest.deleteMany({
        where: { id: { in: createdRequestIds } },
      });
    }
    await app.close();
  });

  beforeEach(() => {
    mockProviderGenerate.mockReset();
    mockProviderGenerate.mockResolvedValue({
      provider: 'stub',
      promptVersion: CONTENT_PROMPT_VERSION,
      title: 'Resilient Title',
      body: 'Resilient Body Content',
      usage: { totalTokens: 25 },
      metadata: { mode: 'test' },
    });
  });

  it('Requirement 1 & 5: Worker restart recovers abandoned job and reconciles draft without creating a duplicate', async () => {
    // 1. Create a request and job in the database
    const req = await prisma.db.contentRequest.create({
      data: {
        workspaceId,
        createdByUserId: userId,
        status: ContentJobStatus.running,
        prompt: 'Simulated Crash Test',
        idempotencyKey: `crash-test-${Date.now()}`,
      },
    });
    createdRequestIds.push(req.id);

    const pastDate = new Date(Date.now() - 30000); // lease expired 30s ago
    const job = await prisma.db.generationJob.create({
      data: {
        workspaceId,
        contentRequestId: req.id,
        status: ContentJobStatus.running,
        provider: 'stub',
        promptVersion: CONTENT_PROMPT_VERSION,
        leaseWorkerId: 'worker-dead-pid-9999',
        leaseExpiresAt: pastDate,
      },
    });

    // Simulate external outcome completed: draft was already persisted before worker died
    await prisma.db.contentDraft.create({
      data: {
        workspaceId,
        contentRequestId: req.id,
        generationJobId: job.id,
        title: 'Draft Before Crash',
        body: 'Original Body Prior to Crash',
        version: 1,
      },
    });

    // 2. Trigger worker restart recovery sweep
    const scanSummary = await recoveryService.recoverStalledJobs();
    expect(scanSummary.recoveredCount).toBeGreaterThanOrEqual(1);

    // 3. Verify reconciliation: job marked succeeded, no second draft created
    const refreshedJob = await prisma.db.generationJob.findUnique({
      where: { id: job.id },
    });
    expect(refreshedJob?.status).toBe(ContentJobStatus.succeeded);
    expect(refreshedJob?.leaseExpiresAt).toBeNull();

    const drafts = await prisma.db.contentDraft.findMany({
      where: { contentRequestId: req.id },
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].body).toBe('Original Body Prior to Crash');
    expect(mockProviderGenerate).not.toHaveBeenCalled();
  });

  it('Requirement 2: Repeated submission with the same idempotency key does not create duplicate operations', async () => {
    const idempotencyKey = `dup-sub-key-${Date.now()}`;
    const payload = {
      topic: 'Topic Idempotency Safety',
      audience: 'Tech Leads',
      format: 'article',
      idempotencyKey,
    };

    // First submission
    const res1 = await request(app.getHttpServer())
      .post('/api/v1/content/requests')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .set('x-workspace-id', workspaceId)
      .send(payload)
      .expect(200);

    const firstRequestId = res1.body.request.id;
    const firstJobId = res1.body.job.id;
    const firstDraftId = res1.body.draft.id;
    createdRequestIds.push(firstRequestId);

    expect(firstRequestId).toBeDefined();
    expect(firstJobId).toBeDefined();

    // Second submission with exact same idempotencyKey
    const res2 = await request(app.getHttpServer())
      .post('/api/v1/content/requests')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .set('x-workspace-id', workspaceId)
      .send(payload)
      .expect(200);

    // Must return the exact same request, job, and draft
    expect(res2.body.request.id).toBe(firstRequestId);
    expect(res2.body.job.id).toBe(firstJobId);
    expect(res2.body.draft.id).toBe(firstDraftId);

    // Total counts in DB for this idempotency key must be exactly 1
    const requestCount = await prisma.db.contentRequest.count({
      where: { workspaceId, idempotencyKey },
    });
    expect(requestCount).toBe(1);

    const jobCount = await prisma.db.generationJob.count({
      where: { contentRequestId: firstRequestId },
    });
    expect(jobCount).toBe(1);
  });

  it('Requirement 3: A recovered job without draft resumes safely and completes without duplicate drafts', async () => {
    // Stalled job where worker died before draft could be generated
    const req = await prisma.db.contentRequest.create({
      data: {
        workspaceId,
        createdByUserId: userId,
        status: ContentJobStatus.running,
        prompt: 'Resumed After Crash Test',
        idempotencyKey: `resume-test-${Date.now()}`,
      },
    });
    createdRequestIds.push(req.id);

    const pastDate = new Date(Date.now() - 10000); // lease expired
    const job = await prisma.db.generationJob.create({
      data: {
        workspaceId,
        contentRequestId: req.id,
        status: ContentJobStatus.running,
        provider: 'stub',
        promptVersion: CONTENT_PROMPT_VERSION,
        leaseWorkerId: 'crashed-worker-old',
        leaseExpiresAt: pastDate,
        retryCount: 0,
        maxRetries: 3,
      },
    });

    // 1. Recovery sweep recovers the stalled job for retry
    await recoveryService.recoverStalledJobs();

    const recoveredJob = await prisma.db.generationJob.findUnique({
      where: { id: job.id },
    });
    expect(recoveredJob?.status).toBe(ContentJobStatus.requested);
    expect(recoveredJob?.retryCount).toBe(1);
    expect(recoveredJob?.leaseWorkerId).toBeNull();

    // 2. Clear nextRetryAt to allow immediate execution in test
    await prisma.db.generationJob.update({
      where: { id: job.id },
      data: { nextRetryAt: null },
    });

    // 3. New worker executes the recovered job
    const execResult = await executor.execute({
      jobId: job.id,
      workspaceId,
      contentRequestId: req.id,
      topic: 'Resumed After Crash Test',
    });

    expect(execResult.status).toBe(ContentJobStatus.succeeded);
    expect(execResult.draftId).toBeDefined();

    // Verify exactly one draft exists
    const drafts = await prisma.db.contentDraft.findMany({
      where: { contentRequestId: req.id },
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].id).toBe(execResult.draftId);
  });

  it('Requirement 4: Completed jobs are never executed again and cannot have leases acquired', async () => {
    // 1. Create already completed job with draft
    const req = await prisma.db.contentRequest.create({
      data: {
        workspaceId,
        createdByUserId: userId,
        status: ContentJobStatus.succeeded,
        prompt: 'Completed Job Protection Test',
      },
    });
    createdRequestIds.push(req.id);

    const job = await prisma.db.generationJob.create({
      data: {
        workspaceId,
        contentRequestId: req.id,
        status: ContentJobStatus.succeeded,
        provider: 'stub',
        promptVersion: CONTENT_PROMPT_VERSION,
        completedAt: new Date(),
      },
    });

    const draft = await prisma.db.contentDraft.create({
      data: {
        workspaceId,
        contentRequestId: req.id,
        generationJobId: job.id,
        title: 'Original Finished Draft',
        body: 'Permanent Finished Body',
        version: 1,
      },
    });

    // 2. Attempt to acquire lease on completed job
    const leaseResult = await leaseService.acquireLease({
      jobId: job.id,
      workspaceId,
      workerId: 'worker-late',
    });

    expect(leaseResult.acquired).toBe(false);
    if (!leaseResult.acquired) {
      expect(leaseResult.reason).toBe('already_completed');
    }

    // 3. Attempt executor.execute on completed job
    const execResult = await executor.execute({
      jobId: job.id,
      workspaceId,
      contentRequestId: req.id,
      topic: 'Attempted Re-run',
    });

    // Reconciler detects draft and returns existing without generating
    expect(execResult.status).toBe(ContentJobStatus.succeeded);
    expect(execResult.draftId).toBe(draft.id);
    expect(mockProviderGenerate).not.toHaveBeenCalled();

    // Draft body unchanged
    const currentDraft = await prisma.db.contentDraft.findUnique({
      where: { id: draft.id },
    });
    expect(currentDraft?.body).toBe('Permanent Finished Body');
  });
});
