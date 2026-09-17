import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ContentJobStatus } from '@prisma/client';

import type { RecordAuditEventInput } from '../audit/audit.service';
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

  describe('updateDraftContent', () => {
    function buildDraft(
      overrides: Partial<{
        id: string;
        workspaceId: string;
        version: number;
        body: string;
      }> = {},
    ) {
      return {
        id: 'draft_1',
        workspaceId: 'ws_alpha',
        contentRequestId: 'req_1',
        generationJobId: 'job_1',
        title: 'Draft: Hello',
        body: 'Original body',
        version: 1,
        provider: 'stub',
        promptVersion: 'content-v1',
        metadata: {},
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides,
      };
    }

    function buildUpdateHarness() {
      const updateMany = jest.fn();
      const findFirst = jest.fn();
      const audit = {
        record: jest
          .fn<Promise<null>, [RecordAuditEventInput]>()
          .mockResolvedValue(null),
      };
      const provider: TextGenerationProvider = {
        name: 'stub',
        generate: jest.fn(),
      };
      const executor: ContentGenerationExecutor = { execute: jest.fn() };

      const prisma = {
        db: {
          contentDraft: { updateMany, findFirst },
        },
      };

      const service = new ContentService(
        prisma as never,
        provider,
        executor,
        audit as never,
      );

      return { service, updateMany, findFirst, audit };
    }

    it('updates the draft and increments the version when the version matches (admin/operator success)', async () => {
      const { service, updateMany, findFirst } = buildUpdateHarness();
      updateMany.mockResolvedValue({ count: 1 });
      findFirst.mockResolvedValue(
        buildDraft({ version: 2, body: 'New content' }),
      );

      const result = await service.updateDraftContent(
        'ws_alpha',
        'user_1',
        'draft_1',
        { content: 'New content', expectedVersion: 1 },
      );

      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'draft_1', workspaceId: 'ws_alpha', version: 1 },
        data: { body: 'New content', version: { increment: 1 } },
      });
      expect(result.version).toBe(2);
      expect(result.body).toBe('New content');
    });

    it('records a sanitized audit event without draft content or secrets', async () => {
      const { service, updateMany, findFirst, audit } = buildUpdateHarness();
      updateMany.mockResolvedValue({ count: 1 });
      findFirst.mockResolvedValue(
        buildDraft({ version: 2, body: 'sk-super-secret-body-content' }),
      );

      await service.updateDraftContent('ws_alpha', 'user_1', 'draft_1', {
        content: 'sk-super-secret-body-content',
        expectedVersion: 1,
      });

      expect(audit.record).toHaveBeenCalledTimes(1);
      const call = audit.record.mock.calls[0][0];
      expect(call).toEqual({
        workspaceId: 'ws_alpha',
        actorId: 'user_1',
        action: 'content_draft.updated',
        resource: 'content_draft',
        resourceId: 'draft_1',
        payload: { previousVersion: 1, newVersion: 2 },
      });
      const serializedPayload = JSON.stringify(call.payload);
      expect(serializedPayload).not.toContain('sk-super-secret-body-content');
      expect(serializedPayload).not.toContain('content');
    });

    it('returns 409 (ConflictException) when the stored version no longer matches', async () => {
      const { service, updateMany, findFirst } = buildUpdateHarness();
      updateMany.mockResolvedValue({ count: 0 });
      findFirst.mockResolvedValue(buildDraft({ version: 5 }));

      await expect(
        service.updateDraftContent('ws_alpha', 'user_1', 'draft_1', {
          content: 'stale write',
          expectedVersion: 1,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('returns 404 (NotFoundException) when the draft belongs to another workspace', async () => {
      const { service, updateMany, findFirst } = buildUpdateHarness();
      updateMany.mockResolvedValue({ count: 0 });
      findFirst.mockResolvedValue(null);

      await expect(
        service.updateDraftContent('ws_alpha', 'user_1', 'draft_other_ws', {
          content: 'attempted cross-tenant write',
          expectedVersion: 1,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects empty or whitespace-only content with 400 (BadRequestException)', async () => {
      const { service, updateMany } = buildUpdateHarness();

      await expect(
        service.updateDraftContent('ws_alpha', 'user_1', 'draft_1', {
          content: '   ',
          expectedVersion: 1,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('only one of two concurrent same-version updates succeeds (prevents lost updates)', async () => {
      const { service, updateMany, findFirst } = buildUpdateHarness();

      // Simulate Postgres row-lock serialization: the first UPDATE to
      // physically run wins (count 1); the second re-evaluates the WHERE
      // clause against the already-bumped row and matches nothing (count 0).
      let claimed = false;
      updateMany.mockImplementation(() => {
        if (!claimed) {
          claimed = true;
          return Promise.resolve({ count: 1 });
        }
        return Promise.resolve({ count: 0 });
      });
      findFirst.mockImplementation(() =>
        Promise.resolve(buildDraft({ version: claimed ? 2 : 1 })),
      );

      const [a, b] = await Promise.allSettled([
        service.updateDraftContent('ws_alpha', 'user_1', 'draft_1', {
          content: 'writer A',
          expectedVersion: 1,
        }),
        service.updateDraftContent('ws_alpha', 'user_1', 'draft_1', {
          content: 'writer B',
          expectedVersion: 1,
        }),
      ]);

      const outcomes = [a, b];
      const succeeded = outcomes.filter((o) => o.status === 'fulfilled');
      const conflicted = outcomes.filter((o) => o.status === 'rejected');

      expect(succeeded).toHaveLength(1);
      expect(conflicted).toHaveLength(1);
      expect(conflicted[0].reason).toBeInstanceOf(ConflictException);
      expect(updateMany).toHaveBeenCalledTimes(2);
    });
  });
});
