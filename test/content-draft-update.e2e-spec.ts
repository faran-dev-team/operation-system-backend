import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { SupabaseService } from '../src/supabase/supabase.service';

const ADMIN_TOKEN = 'test-draft-update-admin-token';
const OPERATOR_TOKEN = 'test-draft-update-operator-token';
const REVIEWER_TOKEN = 'test-draft-update-reviewer-token';
const BETA_OPERATOR_TOKEN = 'test-draft-update-beta-operator-token';

const ADMIN_EMAIL = 'admin.draft-update@pilot.local';
const OPERATOR_EMAIL = 'operator.draft-update@pilot.local';
const REVIEWER_EMAIL = 'reviewer.draft-update@pilot.local';
const BETA_OPERATOR_EMAIL = 'operator.beta.draft-update@pilot.local';

const uniqueAdminAuthId = `sb-auth-admin-draft-update-${Date.now()}`;
const uniqueOperatorAuthId = `sb-auth-operator-draft-update-${Date.now()}`;
const uniqueReviewerAuthId = `sb-auth-reviewer-draft-update-${Date.now()}`;
const uniqueBetaOperatorAuthId = `sb-auth-beta-operator-draft-update-${Date.now()}`;

type DraftResponse = {
  id: string;
  workspaceId: string;
  body: string;
  version: number;
};

type ErrorResponse = {
  message: string | string[];
};

function asDraft(body: unknown): DraftResponse {
  return body as DraftResponse;
}

function asError(body: unknown): ErrorResponse {
  return body as ErrorResponse;
}

describe('Content draft version-safe update (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let alphaWorkspaceId: string;
  let betaWorkspaceId: string;
  let adminUserId: string;
  let operatorUserId: string;
  let reviewerUserId: string;
  let betaOperatorUserId: string;
  const createdRequestIds: string[] = [];

  async function createDraft(workspaceId: string, body: string) {
    const contentRequest = await prisma.db.contentRequest.create({
      data: { workspaceId, prompt: 'Draft update fixture' },
    });
    createdRequestIds.push(contentRequest.id);

    const draft = await prisma.db.contentDraft.create({
      data: {
        workspaceId,
        contentRequestId: contentRequest.id,
        title: 'Fixture draft',
        body,
      },
    });
    return draft;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue({
        check: () => Promise.resolve('ok'),
        getUserFromAccessToken: (token: string) => {
          if (token === ADMIN_TOKEN) {
            return Promise.resolve({
              id: uniqueAdminAuthId,
              email: ADMIN_EMAIL,
            });
          }
          if (token === OPERATOR_TOKEN) {
            return Promise.resolve({
              id: uniqueOperatorAuthId,
              email: OPERATOR_EMAIL,
            });
          }
          if (token === REVIEWER_TOKEN) {
            return Promise.resolve({
              id: uniqueReviewerAuthId,
              email: REVIEWER_EMAIL,
            });
          }
          if (token === BETA_OPERATOR_TOKEN) {
            return Promise.resolve({
              id: uniqueBetaOperatorAuthId,
              email: BETA_OPERATOR_EMAIL,
            });
          }
          return Promise.resolve(null);
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);

    const alpha = await prisma.db.workspace.findUnique({
      where: { slug: 'pilot-alpha' },
    });
    const beta = await prisma.db.workspace.findUnique({
      where: { slug: 'pilot-beta' },
    });
    if (!alpha || !beta) {
      throw new Error('Seed workspaces are missing. Run npm run prisma:seed.');
    }
    alphaWorkspaceId = alpha.id;
    betaWorkspaceId = beta.id;

    const adminUser = await prisma.db.user.upsert({
      where: { email: ADMIN_EMAIL },
      create: {
        email: ADMIN_EMAIL,
        supabaseAuthId: uniqueAdminAuthId,
        name: 'Draft Update Admin',
        currentWorkspaceId: alphaWorkspaceId,
      },
      update: {
        supabaseAuthId: uniqueAdminAuthId,
        currentWorkspaceId: alphaWorkspaceId,
      },
    });
    adminUserId = adminUser.id;
    await prisma.db.membership.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: alphaWorkspaceId,
          userId: adminUserId,
        },
      },
      create: {
        workspaceId: alphaWorkspaceId,
        userId: adminUserId,
        role: 'admin',
      },
      update: { role: 'admin' },
    });

    const operatorUser = await prisma.db.user.upsert({
      where: { email: OPERATOR_EMAIL },
      create: {
        email: OPERATOR_EMAIL,
        supabaseAuthId: uniqueOperatorAuthId,
        name: 'Draft Update Operator',
        currentWorkspaceId: alphaWorkspaceId,
      },
      update: {
        supabaseAuthId: uniqueOperatorAuthId,
        currentWorkspaceId: alphaWorkspaceId,
      },
    });
    operatorUserId = operatorUser.id;
    await prisma.db.membership.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: alphaWorkspaceId,
          userId: operatorUserId,
        },
      },
      create: {
        workspaceId: alphaWorkspaceId,
        userId: operatorUserId,
        role: 'operator',
      },
      update: { role: 'operator' },
    });

    const reviewerUser = await prisma.db.user.upsert({
      where: { email: REVIEWER_EMAIL },
      create: {
        email: REVIEWER_EMAIL,
        supabaseAuthId: uniqueReviewerAuthId,
        name: 'Draft Update Reviewer',
        currentWorkspaceId: alphaWorkspaceId,
      },
      update: {
        supabaseAuthId: uniqueReviewerAuthId,
        currentWorkspaceId: alphaWorkspaceId,
      },
    });
    reviewerUserId = reviewerUser.id;
    await prisma.db.membership.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: alphaWorkspaceId,
          userId: reviewerUserId,
        },
      },
      create: {
        workspaceId: alphaWorkspaceId,
        userId: reviewerUserId,
        role: 'reviewer',
      },
      update: { role: 'reviewer' },
    });

    const betaOperatorUser = await prisma.db.user.upsert({
      where: { email: BETA_OPERATOR_EMAIL },
      create: {
        email: BETA_OPERATOR_EMAIL,
        supabaseAuthId: uniqueBetaOperatorAuthId,
        name: 'Draft Update Beta Operator',
        currentWorkspaceId: betaWorkspaceId,
      },
      update: {
        supabaseAuthId: uniqueBetaOperatorAuthId,
        currentWorkspaceId: betaWorkspaceId,
      },
    });
    betaOperatorUserId = betaOperatorUser.id;
    await prisma.db.membership.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: betaWorkspaceId,
          userId: betaOperatorUserId,
        },
      },
      create: {
        workspaceId: betaWorkspaceId,
        userId: betaOperatorUserId,
        role: 'operator',
      },
      update: { role: 'operator' },
    });
  });

  afterAll(async () => {
    try {
      if (createdRequestIds.length > 0) {
        // ContentDraft cascades from ContentRequest deletion.
        await prisma.db.contentRequest.deleteMany({
          where: { id: { in: createdRequestIds } },
        });
      }
      for (const userId of [
        adminUserId,
        operatorUserId,
        reviewerUserId,
        betaOperatorUserId,
      ]) {
        if (userId) {
          await prisma.db.membership.deleteMany({ where: { userId } });
          await prisma.db.user.deleteMany({ where: { id: userId } });
        }
      }
    } finally {
      if (app) {
        await app.close();
      }
    }
  });

  it('allows an operator to update a draft and increments the version', async () => {
    const draft = await createDraft(alphaWorkspaceId, 'Original operator body');

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/content/drafts/${draft.id}`)
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`)
      .send({ content: 'Updated by operator', expectedVersion: 1 });

    expect(res.status).toBe(200);
    expect(asDraft(res.body).body).toBe('Updated by operator');
    expect(asDraft(res.body).version).toBe(2);
  });

  it('allows an admin to update a draft and increments the version', async () => {
    const draft = await createDraft(alphaWorkspaceId, 'Original admin body');

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/content/drafts/${draft.id}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ content: 'Updated by admin', expectedVersion: 1 });

    expect(res.status).toBe(200);
    expect(asDraft(res.body).body).toBe('Updated by admin');
    expect(asDraft(res.body).version).toBe(2);
  });

  it('rejects a reviewer with 403 Forbidden', async () => {
    const draft = await createDraft(
      alphaWorkspaceId,
      'Reviewer must not edit this',
    );

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/content/drafts/${draft.id}`)
      .set('Authorization', `Bearer ${REVIEWER_TOKEN}`)
      .send({ content: 'Attempted reviewer edit', expectedVersion: 1 });

    expect(res.status).toBe(403);
    expect(asError(res.body).message).toContain(
      'Insufficient permissions for this workspace',
    );

    const unchanged = await prisma.db.contentDraft.findUnique({
      where: { id: draft.id },
    });
    expect(unchanged?.body).toBe('Reviewer must not edit this');
    expect(unchanged?.version).toBe(1);
  });

  it('rejects updating a draft that belongs to another workspace with 404', async () => {
    const betaDraft = await createDraft(
      betaWorkspaceId,
      'Beta confidential draft body',
    );

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/content/drafts/${betaDraft.id}`)
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`) // alpha operator
      .send({ content: 'Cross-tenant write attempt', expectedVersion: 1 });

    expect(res.status).toBe(404);
    expect(asError(res.body).message).toContain(
      'Record was not found in this workspace',
    );

    const unchanged = await prisma.db.contentDraft.findUnique({
      where: { id: betaDraft.id },
    });
    expect(unchanged?.body).toBe('Beta confidential draft body');
  });

  it('returns 409 Conflict when expectedVersion is stale', async () => {
    const draft = await createDraft(alphaWorkspaceId, 'Version one body');

    const first = await request(app.getHttpServer())
      .patch(`/api/v1/content/drafts/${draft.id}`)
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`)
      .send({ content: 'Version two body', expectedVersion: 1 });
    expect(first.status).toBe(200);
    expect(asDraft(first.body).version).toBe(2);

    const stale = await request(app.getHttpServer())
      .patch(`/api/v1/content/drafts/${draft.id}`)
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`)
      .send({ content: 'Attempted stale write', expectedVersion: 1 });

    expect(stale.status).toBe(409);
    expect(asError(stale.body).message).toContain('stale');

    const current = await prisma.db.contentDraft.findUnique({
      where: { id: draft.id },
    });
    expect(current?.version).toBe(2);
    expect(current?.body).toBe('Version two body');
  });

  it('prevents lost updates: only one of two concurrent same-version requests succeeds', async () => {
    const draft = await createDraft(
      alphaWorkspaceId,
      'Concurrency fixture body',
    );

    const [a, b] = await Promise.all([
      request(app.getHttpServer())
        .patch(`/api/v1/content/drafts/${draft.id}`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN}`)
        .send({ content: 'Writer A content', expectedVersion: 1 }),
      request(app.getHttpServer())
        .patch(`/api/v1/content/drafts/${draft.id}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        .send({ content: 'Writer B content', expectedVersion: 1 }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = asDraft((a.status === 200 ? a : b).body);
    expect(winner.version).toBe(2);

    const final = await prisma.db.contentDraft.findUnique({
      where: { id: draft.id },
    });
    expect(final?.version).toBe(2);
    expect(final?.body).toBe(winner.body);
  });

  it('records a sanitized audit event with workspace, actor, draft ID, and version transition only', async () => {
    const draft = await createDraft(
      alphaWorkspaceId,
      'Body containing sk-should-never-leak-1234567890',
    );

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/content/drafts/${draft.id}`)
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`)
      .send({
        content: 'Updated body with token sk-another-secret-value-0987654321',
        expectedVersion: 1,
      });
    expect(res.status).toBe(200);

    const logs = await prisma.db.auditLog.findMany({
      where: {
        workspaceId: alphaWorkspaceId,
        resource: 'content_draft',
        resourceId: draft.id,
        action: 'content_draft.updated',
      },
    });
    expect(logs).toHaveLength(1);

    const log = logs[0];
    expect(log.workspaceId).toBe(alphaWorkspaceId);
    expect(log.actorId).toBe(operatorUserId);
    expect(log.resourceId).toBe(draft.id);
    expect(log.payload).toEqual({ previousVersion: 1, newVersion: 2 });

    const serializedPayload = JSON.stringify(log.payload);
    expect(serializedPayload).not.toContain(
      'sk-another-secret-value-0987654321',
    );
    expect(serializedPayload).not.toContain('Updated body');
    expect(serializedPayload).not.toContain('content');
    expect(serializedPayload).not.toContain('body');
  });
});
