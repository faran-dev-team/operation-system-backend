import { ContentJobStatus } from '@prisma/client';

import { DefaultContentGenerationExecutor } from './content-generation.executor';
import {
  GenerationProviderError,
  type TextGenerationProvider,
} from './text-generation.types';

describe('DefaultContentGenerationExecutor', () => {
  function buildPrisma(overrides?: {
    claimCount?: number;
    existingStatus?: ContentJobStatus;
    existingDraft?: { id: string } | null;
  }) {
    const claimCount = overrides?.claimCount ?? 1;
    const draft = { id: 'draft_1' };
    const updateMany = jest.fn().mockResolvedValue({ count: claimCount });
    const findFirst = jest.fn().mockResolvedValue({
      id: 'job_1',
      status: overrides?.existingStatus ?? ContentJobStatus.succeeded,
      draft,
      errorCode: null,
      errorMessage: null,
      retryCount: 0,
      maxRetries: 3,
    });

    return {
      db: {
        generationJob: {
          updateMany,
          findFirst,
          update: jest.fn().mockResolvedValue({}),
        },
        contentRequest: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue({}),
        },
        contentDraft: {
          findFirst: jest
            .fn()
            .mockResolvedValue(overrides?.existingDraft ?? null),
          upsert: jest.fn().mockResolvedValue(draft),
        },
        $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            contentDraft: {
              upsert: jest.fn().mockResolvedValue(draft),
            },
            generationJob: {
              update: jest.fn().mockResolvedValue({}),
            },
            contentRequest: {
              update: jest.fn().mockResolvedValue({}),
            },
          }),
        ),
      },
      updateMany,
    };
  }

  const input = {
    jobId: 'job_1',
    workspaceId: 'ws_1',
    contentRequestId: 'req_1',
    topic: 'Topic',
  };

  it('transitions requested → running → succeeded and persists a draft', async () => {
    const prisma = buildPrisma();
    const generate = jest.fn().mockResolvedValue({
      provider: 'stub',
      promptVersion: 'content-v1',
      title: 'Draft: Topic',
      body: 'Body',
      usage: { totalTokens: 10 },
      metadata: { mode: 'stub' },
    });
    const provider: TextGenerationProvider = {
      name: 'stub',
      generate,
    };

    const executor = new DefaultContentGenerationExecutor(
      prisma as never,
      provider,
    );
    const result = await executor.execute(input);

    expect(prisma.updateMany).toHaveBeenCalled();
    expect(generate).toHaveBeenCalled();
    expect(result).toEqual({
      status: ContentJobStatus.succeeded,
      draftId: 'draft_1',
    });
  });

  it('reconciles without regenerating when a draft is already present', async () => {
    const prisma = buildPrisma({
      existingDraft: { id: 'pre_existing_draft_42' },
    });
    const generate = jest.fn();
    const provider: TextGenerationProvider = {
      name: 'stub',
      generate,
    };

    const executor = new DefaultContentGenerationExecutor(
      prisma as never,
      provider,
    );
    const result = await executor.execute(input);

    expect(generate).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: ContentJobStatus.succeeded,
      draftId: 'pre_existing_draft_42',
    });
  });

  it('marks the job for retry with a safe error when provider fails', async () => {
    const prisma = buildPrisma();
    const provider: TextGenerationProvider = {
      name: 'deepseek',
      generate: jest
        .fn()
        .mockRejectedValue(
          new GenerationProviderError(
            'provider_timeout',
            'DeepSeek request timed out.',
            new Error('secret-api-key-should-not-leak'),
          ),
        ),
    };

    const executor = new DefaultContentGenerationExecutor(
      prisma as never,
      provider,
    );
    const result = await executor.execute(input);

    expect(result).toEqual({
      status: ContentJobStatus.failed,
      errorCode: 'provider_timeout',
      errorMessage: 'DeepSeek request timed out.',
    });
    expect(JSON.stringify(result)).not.toContain('secret-api-key');
  });

  it('does not regenerate when the job was already claimed', async () => {
    const prisma = buildPrisma({
      claimCount: 0,
      existingStatus: ContentJobStatus.succeeded,
    });
    const generate = jest.fn();
    const provider: TextGenerationProvider = {
      name: 'stub',
      generate,
    };

    const executor = new DefaultContentGenerationExecutor(
      prisma as never,
      provider,
    );
    const result = await executor.execute(input);

    expect(generate).not.toHaveBeenCalled();
    expect(result.status).toBe(ContentJobStatus.succeeded);
    expect(result.draftId).toBe('draft_1');
  });
});
