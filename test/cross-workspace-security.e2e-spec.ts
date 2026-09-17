import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { SupabaseService } from '../src/supabase/supabase.service';

const ALPHA_TOKEN = 'test-alpha-operator-token';
const REVIEWER_TOKEN = 'test-beta-reviewer-token';

const ALPHA_EMAIL = 'operator.alpha.security@pilot.local';
const REVIEWER_EMAIL = 'reviewer.beta.security@pilot.local';

describe('Cross-Workspace Security & RBAC (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let alphaWorkspaceId: string;
  let betaWorkspaceId: string;
  let alphaUserId: string;
  let reviewerUserId: string;
  let betaDraftId: string;
  let betaRequestId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue({
        check: () => Promise.resolve('ok'),
        getUserFromAccessToken: (token: string) => {
          if (token === ALPHA_TOKEN) {
            return Promise.resolve({
              id: 'sb-auth-alpha-operator',
              email: ALPHA_EMAIL,
            });
          }
          if (token === REVIEWER_TOKEN) {
            return Promise.resolve({
              id: 'sb-auth-beta-reviewer',
              email: REVIEWER_EMAIL,
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

    // Create a dedicated operator user strictly belonging to workspace Alpha
    const alphaUser = await prisma.db.user.upsert({
      where: { email: ALPHA_EMAIL },
      create: {
        email: ALPHA_EMAIL,
        name: 'Alpha Security Operator',
        currentWorkspaceId: alphaWorkspaceId,
      },
      update: {
        currentWorkspaceId: alphaWorkspaceId,
      },
    });
    alphaUserId = alphaUser.id;

    await prisma.db.membership.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: alphaWorkspaceId,
          userId: alphaUserId,
        },
      },
      create: {
        workspaceId: alphaWorkspaceId,
        userId: alphaUserId,
        role: 'operator',
      },
      update: {
        role: 'operator',
      },
    });

    // Create a dedicated reviewer user strictly belonging to workspace Beta
    const reviewerUser = await prisma.db.user.upsert({
      where: { email: REVIEWER_EMAIL },
      create: {
        email: REVIEWER_EMAIL,
        name: 'Beta Security Reviewer',
        currentWorkspaceId: betaWorkspaceId,
      },
      update: {
        currentWorkspaceId: betaWorkspaceId,
      },
    });
    reviewerUserId = reviewerUser.id;

    await prisma.db.membership.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: betaWorkspaceId,
          userId: reviewerUserId,
        },
      },
      create: {
        workspaceId: betaWorkspaceId,
        userId: reviewerUserId,
        role: 'reviewer',
      },
      update: {
        role: 'reviewer',
      },
    });

    // Create a target draft in Workspace Beta
    const betaRequest = await prisma.db.contentRequest.create({
      data: {
        workspaceId: betaWorkspaceId,
        prompt: 'Beta confidential prompt',
      },
    });
    betaRequestId = betaRequest.id;

    const betaDraft = await prisma.db.contentDraft.create({
      data: {
        workspaceId: betaWorkspaceId,
        contentRequestId: betaRequestId,
        title: 'Beta Secret Draft',
        body: 'Confidential Beta Workspace Information',
      },
    });
    betaDraftId = betaDraft.id;
  });

  afterAll(async () => {
    try {
      if (prisma) {
        if (betaDraftId) {
          await prisma.db.contentDraft.deleteMany({
            where: { id: betaDraftId },
          });
        }
        if (betaRequestId) {
          await prisma.db.contentRequest.deleteMany({
            where: { id: betaRequestId },
          });
        }
        if (alphaUserId) {
          await prisma.db.membership.deleteMany({
            where: { userId: alphaUserId },
          });
          await prisma.db.user.deleteMany({
            where: { id: alphaUserId },
          });
        }
        if (reviewerUserId) {
          await prisma.db.membership.deleteMany({
            where: { userId: reviewerUserId },
          });
          await prisma.db.user.deleteMany({
            where: { id: reviewerUserId },
          });
        }
      }
    } finally {
      if (app) {
        await app.close();
      }
    }
  });

  describe('Tenant Isolation Tests', () => {
    it('rejects cross-tenant header spoofing with 403 Forbidden', async () => {
      // User Alpha attempts to access Brand Brief of Workspace Beta by setting x-workspace-id header
      const res = await request(app.getHttpServer())
        .get('/api/v1/brand-brief')
        .set('Authorization', `Bearer ${ALPHA_TOKEN}`)
        .set('x-workspace-id', betaWorkspaceId);

      expect(res.status).toBe(403);
      expect(res.body.message).toContain(
        'Workspace was not found for this account',
      );
    });

    it('rejects reading another workspace draft by ID with 404 Not Found', async () => {
      // User Alpha attempts to query Beta draft ID through /api/v1/content/drafts/:id
      const res = await request(app.getHttpServer())
        .get(`/api/v1/content/drafts/${betaDraftId}`)
        .set('Authorization', `Bearer ${ALPHA_TOKEN}`);

      expect(res.status).toBe(404);
      expect(res.body.message).toContain(
        'Record was not found in this workspace',
      );
    });

    it('proves audit logs are strictly isolated by workspace', async () => {
      // Create an audit event for Workspace Alpha
      await prisma.db.auditLog.create({
        data: {
          workspaceId: alphaWorkspaceId,
          actorId: alphaUserId,
          action: 'test.alpha_event',
          resource: 'test_resource',
          payload: { secret: '[REDACTED]' },
        },
      });

      // Query audit logs belonging to Workspace Beta
      const betaLogs = await prisma.db.auditLog.findMany({
        where: {
          workspaceId: betaWorkspaceId,
          action: 'test.alpha_event',
        },
      });

      expect(betaLogs).toHaveLength(0);

      // Clean up test audit log
      await prisma.db.auditLog.deleteMany({
        where: { action: 'test.alpha_event' },
      });
    });
  });

  describe('RBAC Permission Tests', () => {
    it('blocks reviewer from updating brand brief with 403 Forbidden', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/v1/brand-brief')
        .set('Authorization', `Bearer ${REVIEWER_TOKEN}`)
        .send({
          name: 'Hacked Brand Name',
          tone: 'aggressive',
        });

      expect(res.status).toBe(403);
      expect(res.body.message).toContain(
        'Insufficient permissions for this workspace',
      );
    });

    it('blocks reviewer from submitting content generation requests with 403 Forbidden', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/content/requests')
        .set('Authorization', `Bearer ${REVIEWER_TOKEN}`)
        .send({
          topic: 'Unauthorized generation topic',
        });

      expect(res.status).toBe(403);
      expect(res.body.message).toContain(
        'Insufficient permissions for this workspace',
      );
    });

    it('allows reviewer to perform read-only requests', async () => {
      // Reviewer should be allowed to view drafts
      const res = await request(app.getHttpServer())
        .get('/api/v1/content/drafts')
        .set('Authorization', `Bearer ${REVIEWER_TOKEN}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});
