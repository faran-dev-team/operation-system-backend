import { ContentJobStatus } from '@prisma/client';

import { ContentService } from './content.service';
import type { ContentGenerationExecutor } from './generation/content-generation.executor';
import type { TextGenerationProvider } from './generation/text-generation.types';

describe('ContentService', () => {
  const provider: TextGenerationProvider = {
    name: 'stub',
    generate: jest.fn(),
  };

  function buildService(options?: {
    existing?: unknown;
    createdRequestId?: string;
    createdJobId?: string;
    draftId?: string;
  }) {
    const requestId = options?.createdRequestId ?? 'req_1';
    const jobId = options?.createdJobId ?? 'job_1';
    const draftId = options?.draftId ?? 'draft_1';

    const draft = {
      id: draftId,
      workspaceId: 'ws_alpha',
      contentRequestId: requestId,
      generationJobId: jobId,
      title: 'Draft: Hello',
      body: 'Body',
      version: 1,
      provider: 'stub',
      promptVersion: 'content-v1',
      metadata: { mode: 'stub' },
      createdAt: new Date('2026-01-01T00:00:02.000Z'),
      updatedAt: new Date('2026-01-01T00:00:02.000Z'),
    };

    const job = {
      id: jobId,
      workspaceId: 'ws_alpha',
      contentRequestId: requestId,
      status: ContentJobStatus.succeeded,
      provider: 'stub',
      promptVersion: 'content-v1',
      errorCode: null,
      errorMessage: null,
      startedAt: new Date('2026-01-01T00:00:01.000Z'),
      completedAt: new Date('2026-01-01T00:00:02.000Z'),
      usageMetadata: { totalTokens: 96 },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:02.000Z'),
      draft,
    };

    const requestRow = {
      id: requestId,
      workspaceId: 'ws_alpha',
      createdByUserId: 'user_1',
      status: ContentJobStatus.succeeded,
      input: { topic: 'Hello' },
      idempotencyKey: 'key-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      generationJobs: [job],
      drafts: [],
    };

    const contentRequestCreate = jest.fn().mockResolvedValue({
      id: requestId,
      workspaceId: 'ws_alpha',
      createdByUserId: 'user_1',
      status: ContentJobStatus.requested,
      input: { topic: 'Hello' },
      idempotencyKey: 'key-1',
      createdAt: new Date(),
    });
    const generationJobCreate = jest.fn().mockResolvedValue({
      id: jobId,
      workspaceId: 'ws_alpha',
      contentRequestId: requestId,
      status: ContentJobStatus.requested,
      provider: 'stub',
      promptVersion: 'content-v1',
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      usageMetadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const generationJobFindFirst = jest.fn().mockResolvedValue(job);
    const contentDraftFindFirst = jest.fn().mockResolvedValue(draft);
    const contentDraftFindMany = jest.fn().mockResolvedValue([draft]);

    const prisma = {
      db: {
        contentRequest: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(options?.existing ?? null)
            .mockResolvedValue(requestRow),
          create: contentRequestCreate,
        },
        generationJob: {
          create: generationJobCreate,
          findFirst: generationJobFindFirst,
        },
        contentDraft: {
          findFirst: contentDraftFindFirst,
          findMany: contentDraftFindMany,
        },
        brandBrief: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
        $transaction: jest.fn(
          async (
            fn: (tx: {
              contentRequest: { create: typeof contentRequestCreate };
              generationJob: { create: typeof generationJobCreate };
            }) => Promise<unknown>,
          ) =>
            fn({
              contentRequest: { create: contentRequestCreate },
              generationJob: { create: generationJobCreate },
            }),
        ),
      },
    };

    const execute = jest.fn().mockResolvedValue({
      status: ContentJobStatus.succeeded,
      draftId,
    });
    const executor: ContentGenerationExecutor = { execute };
    const audit = { record: jest.fn().mockResolvedValue(null) };

    const service = new ContentService(
      prisma as never,
      provider,
      executor,
      audit as never,
    );

    return { service, prisma, execute, generationJobFindFirst };
  }

  it('returns the existing request/job/draft for a repeated idempotency key', async () => {
    const existingDraft = {
      id: 'draft_existing',
      workspaceId: 'ws_alpha',
      contentRequestId: 'req_existing',
      generationJobId: 'job_existing',
      title: 'Existing',
      body: 'Existing body',
      version: 1,
      provider: 'stub',
      promptVersion: 'content-v1',
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const existingJob = {
      id: 'job_existing',
      workspaceId: 'ws_alpha',
      contentRequestId: 'req_existing',
      status: ContentJobStatus.succeeded,
      provider: 'stub',
      promptVersion: 'content-v1',
      errorCode: null,
      errorMessage: null,
      startedAt: new Date(),
      completedAt: new Date(),
      usageMetadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      draft: existingDraft,
    };
    const existingRequest = {
      id: 'req_existing',
      workspaceId: 'ws_alpha',
      createdByUserId: 'user_1',
      status: ContentJobStatus.succeeded,
      input: { topic: 'Hello' },
      idempotencyKey: 'key-1',
      createdAt: new Date(),
      generationJobs: [existingJob],
      drafts: [existingDraft],
    };

    const { service, execute } = buildService({ existing: existingRequest });
    const result = await service.submit('ws_alpha', 'user_1', {
      topic: 'Hello',
      idempotencyKey: 'key-1',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.request.id).toBe('req_existing');
    expect(result.job?.id).toBe('job_existing');
    expect(result.draft?.id).toBe('draft_existing');
  });

  it('creates a request, runs the executor, and returns the draft', async () => {
    const { service, execute } = buildService();
    const result = await service.submit('ws_alpha', 'user_1', {
      topic: 'Hello',
      idempotencyKey: 'key-1',
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws_alpha',
        topic: 'Hello',
      }),
    );
    expect(result.job?.status).toBe(ContentJobStatus.succeeded);
    expect(result.draft?.body).toBe('Body');
  });

  it('rejects conflicting header and body idempotency keys', async () => {
    const { service, execute } = buildService();

    await expect(
      service.submit(
        'ws_alpha',
        'user_1',
        { topic: 'Hello', idempotencyKey: 'body-key' },
        'header-key',
      ),
    ).rejects.toThrow(
      'Idempotency-Key header and body idempotencyKey must match when both are provided.',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('scopes job retrieval to the active workspace', async () => {
    const { service, generationJobFindFirst } = buildService();
    generationJobFindFirst.mockResolvedValueOnce(null);

    await expect(service.getJob('ws_alpha', 'job_other')).rejects.toThrow(
      'Record was not found in this workspace.',
    );
  });
});
