import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { SupabaseService } from '../src/supabase/supabase.service';

const ALPHA_TOKEN = 'valid-alpha-token';
const BETA_TOKEN = 'valid-beta-token';
const ALPHA_EMAIL = 'operator.alpha@pilot.local';
const BETA_EMAIL = 'operator.beta@pilot.local';

function readId(body: unknown): string {
  if (
    typeof body === 'object' &&
    body !== null &&
    'id' in body &&
    typeof body.id === 'string'
  ) {
    return body.id;
  }
  throw new Error('Response body did not include a string id.');
}

describe('Brand brief (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let alphaWorkspaceId: string;
  let betaWorkspaceId: string;
  const createdBriefIds: string[] = [];

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
              id: 'sb-auth-alpha',
              email: ALPHA_EMAIL,
            });
          }
          if (token === BETA_TOKEN) {
            return Promise.resolve({
              id: 'sb-auth-beta',
              email: BETA_EMAIL,
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

    await prisma.db.brandBrief.deleteMany({
      where: {
        workspaceId: { in: [alphaWorkspaceId, betaWorkspaceId] },
      },
    });
  });

  afterAll(async () => {
    try {
      if (createdBriefIds.length > 0) {
        await prisma.db.brandBrief.deleteMany({
          where: { id: { in: createdBriefIds } },
        });
      }
    } finally {
      await app.close();
    }
  });

  it('rejects unauthenticated brand brief access', async () => {
    await request(app.getHttpServer()).get('/api/v1/brand-brief').expect(401);
  });

  it('returns 404 when the workspace has no brand brief yet', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/brand-brief')
      .set('Authorization', `Bearer ${ALPHA_TOKEN}`)
      .expect(404);

    expect(response.body).toMatchObject({ statusCode: 404 });
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(response.body).toMatchObject({
      requestId: response.headers['x-request-id'],
    });
  });

  it('creates and reads a brand brief for the current workspace only', async () => {
    const putResponse = await request(app.getHttpServer())
      .put('/api/v1/brand-brief')
      .set('Authorization', `Bearer ${ALPHA_TOKEN}`)
      .send({
        name: 'Pilot Alpha',
        tone: 'clear and direct',
        approvedFacts: 'Ships in 19 working days.',
        prohibitedClaims: 'Do not promise unlimited scale.',
      })
      .expect(200);

    expect(putResponse.body).toMatchObject({
      workspaceId: alphaWorkspaceId,
      name: 'Pilot Alpha',
      tone: 'clear and direct',
    });
    const createdId = readId(putResponse.body);
    createdBriefIds.push(createdId);

    const getResponse = await request(app.getHttpServer())
      .get('/api/v1/brand-brief')
      .set('Authorization', `Bearer ${ALPHA_TOKEN}`)
      .expect(200);

    expect(getResponse.body).toMatchObject({
      id: createdId,
      workspaceId: alphaWorkspaceId,
      name: 'Pilot Alpha',
    });
  });

  it('updates the existing brand brief for the same workspace', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/v1/brand-brief')
      .set('Authorization', `Bearer ${ALPHA_TOKEN}`)
      .send({
        name: 'Pilot Alpha Updated',
        tone: 'confident',
      })
      .expect(200);

    expect(response.body).toMatchObject({
      workspaceId: alphaWorkspaceId,
      name: 'Pilot Alpha Updated',
      tone: 'confident',
      approvedFacts: null,
      prohibitedClaims: null,
    });
    const updatedId = readId(response.body);
    createdBriefIds.push(updatedId);
  });

  it('does not let workspace B read workspace A brand brief', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/brand-brief')
      .set('Authorization', `Bearer ${BETA_TOKEN}`)
      .expect(404);

    const betaPut = await request(app.getHttpServer())
      .put('/api/v1/brand-brief')
      .set('Authorization', `Bearer ${BETA_TOKEN}`)
      .send({
        name: 'Pilot Beta',
        tone: 'friendly',
      })
      .expect(200);

    const betaId = readId(betaPut.body);
    createdBriefIds.push(betaId);
    expect(betaPut.body).toMatchObject({
      workspaceId: betaWorkspaceId,
      name: 'Pilot Beta',
    });
    expect(betaPut.body).not.toMatchObject({
      workspaceId: alphaWorkspaceId,
    });

    const alphaGet = await request(app.getHttpServer())
      .get('/api/v1/brand-brief')
      .set('Authorization', `Bearer ${ALPHA_TOKEN}`)
      .expect(200);

    expect(alphaGet.body).toMatchObject({
      workspaceId: alphaWorkspaceId,
      name: 'Pilot Alpha Updated',
    });
  });

  it('echoes x-request-id on errors', async () => {
    const requestId = 'brand-brief-contract-test-id';
    const response = await request(app.getHttpServer())
      .get('/api/v1/brand-brief')
      .set('x-request-id', requestId)
      .expect(401);

    expect(response.headers['x-request-id']).toBe(requestId);
    expect(response.body).toMatchObject({
      statusCode: 401,
      requestId,
    });
  });
});
