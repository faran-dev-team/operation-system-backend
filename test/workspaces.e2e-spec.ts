import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { SupabaseService } from '../src/supabase/supabase.service';

const VALID_TOKEN = 'valid-alpha-token';
const ALPHA_EMAIL = 'operator.alpha@pilot.local';

describe('Workspaces (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let alphaUser: { id: string; currentWorkspaceId: string | null };
  let alphaWorkspace: { id: string; slug: string };
  let betaWorkspace: { id: string; slug: string };
  let addedMembershipId: string | null = null;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue({
        check: () => Promise.resolve('ok'),
        getUserFromAccessToken: (token: string) => {
          if (token === VALID_TOKEN) {
            return Promise.resolve({
              id: 'sb-auth-alpha',
              email: ALPHA_EMAIL,
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

    const user = await prisma.db.user.findUnique({
      where: { email: ALPHA_EMAIL },
    });
    const alpha = await prisma.db.workspace.findUnique({
      where: { slug: 'pilot-alpha' },
    });
    const beta = await prisma.db.workspace.findUnique({
      where: { slug: 'pilot-beta' },
    });

    if (!user || !alpha || !beta) {
      throw new Error('Seed data is missing. Run npm run prisma:seed.');
    }

    // Ensure clean state: delete any stale beta membership from previous interrupted test runs
    await prisma.db.membership.deleteMany({
      where: {
        userId: user.id,
        workspaceId: beta.id,
      },
    });
    await prisma.db.user.update({
      where: { id: user.id },
      data: { currentWorkspaceId: alpha.id },
    });

    alphaUser = { id: user.id, currentWorkspaceId: alpha.id };
    alphaWorkspace = { id: alpha.id, slug: alpha.slug };
    betaWorkspace = { id: beta.id, slug: beta.slug };
  });

  afterAll(async () => {
    try {
      if (addedMembershipId) {
        await prisma.db.membership.delete({
          where: { id: addedMembershipId },
        });
      }
      await prisma.db.user.update({
        where: { id: alphaUser.id },
        data: { currentWorkspaceId: alphaUser.currentWorkspaceId },
      });
    } finally {
      await app.close();
    }
  });

  it('rejects GET /api/v1/workspaces when not authenticated', async () => {
    await request(app.getHttpServer()).get('/api/v1/workspaces').expect(401);
  });

  it('lists only workspaces belonging to the authenticated user', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/workspaces')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .expect(200);

    const workspaces = response.body as Array<{
      id: string;
      slug: string;
      role: string;
      isCurrent: boolean;
    }>;
    expect(Array.isArray(workspaces)).toBe(true);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      id: alphaWorkspace.id,
      slug: 'pilot-alpha',
      role: 'operator',
      isCurrent: true,
    });
  });

  it('switches workspace and ensures all subsequent queries use the switched workspace', async () => {
    // 1. Add user to second workspace (Beta)
    const membership = await prisma.db.membership.create({
      data: {
        userId: alphaUser.id,
        workspaceId: betaWorkspace.id,
        role: 'reviewer',
      },
    });
    addedMembershipId = membership.id;

    // 2. Listing workspaces now shows both workspaces
    const listResponse = await request(app.getHttpServer())
      .get('/api/v1/workspaces')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .expect(200);

    const workspaces = listResponse.body as Array<{
      id: string;
      slug: string;
      role: string;
      isCurrent: boolean;
    }>;
    expect(workspaces).toHaveLength(2);
    expect(workspaces.map((w) => w.slug)).toEqual(
      expect.arrayContaining(['pilot-alpha', 'pilot-beta']),
    );

    // 3. Before switch, GET /api/v1/me returns pilot-alpha
    const meBefore = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .expect(200);
    expect(meBefore.body).toMatchObject({
      workspace: { slug: 'pilot-alpha' },
    });

    // 4. POST /api/v1/workspaces/switch to pilot-beta
    const switchResponse = await request(app.getHttpServer())
      .post('/api/v1/workspaces/switch')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({ workspaceId: betaWorkspace.id })
      .expect(200);

    expect(switchResponse.body).toMatchObject({
      workspace: {
        id: betaWorkspace.id,
        slug: 'pilot-beta',
        role: 'reviewer',
      },
    });

    // 5. Subsequent query GET /api/v1/me WITHOUT x-workspace-id header uses pilot-beta!
    const meAfter = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .expect(200);

    expect(meAfter.body).toMatchObject({
      workspace: {
        slug: 'pilot-beta',
        role: 'reviewer',
      },
    });

    // 6. GET /api/v1/workspaces now indicates pilot-beta is current
    const listAfter = await request(app.getHttpServer())
      .get('/api/v1/workspaces')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .expect(200);

    const afterWorkspaces = listAfter.body as Array<{
      slug: string;
      isCurrent: boolean;
    }>;
    const betaItem = afterWorkspaces.find((w) => w.slug === 'pilot-beta');
    const alphaItem = afterWorkspaces.find((w) => w.slug === 'pilot-alpha');
    expect(betaItem?.isCurrent).toBe(true);
    expect(alphaItem?.isCurrent).toBe(false);
  });

  it('rejects switching to a workspace the user does not belong to', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/workspaces/switch')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({ workspaceId: 'non-existent-workspace-id' })
      .expect(403);
  });
});
