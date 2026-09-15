import { NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { BrandBriefService } from './brand-brief.service';

describe('BrandBriefService', () => {
  const prisma = {
    db: {
      brandBrief: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
    },
  };

  const service = new BrandBriefService(prisma as unknown as PrismaService);

  const brief = {
    id: 'brief-1',
    workspaceId: 'ws-alpha',
    name: 'Pilot Alpha',
    tone: 'clear',
    approvedFacts: 'Ships in 19 days.',
    prohibitedClaims: 'No unlimited scale.',
    createdAt: new Date('2026-09-15T10:00:00.000Z'),
    updatedAt: new Date('2026-09-15T11:00:00.000Z'),
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns the brand brief for the current workspace', async () => {
    prisma.db.brandBrief.findUnique.mockResolvedValue(brief);

    await expect(service.get('ws-alpha')).resolves.toEqual({
      id: 'brief-1',
      workspaceId: 'ws-alpha',
      name: 'Pilot Alpha',
      tone: 'clear',
      approvedFacts: 'Ships in 19 days.',
      prohibitedClaims: 'No unlimited scale.',
      createdAt: brief.createdAt,
      updatedAt: brief.updatedAt,
    });

    expect(prisma.db.brandBrief.findUnique).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-alpha' },
    });
  });

  it('returns 404 when the workspace has no brand brief', async () => {
    prisma.db.brandBrief.findUnique.mockResolvedValue(null);

    await expect(service.get('ws-alpha')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('creates or updates the brand brief for the current workspace only', async () => {
    prisma.db.brandBrief.upsert.mockResolvedValue(brief);

    await expect(
      service.upsert('ws-alpha', {
        name: '  Pilot Alpha  ',
        tone: ' clear ',
        approvedFacts: ' Ships in 19 days. ',
        prohibitedClaims: ' No unlimited scale. ',
      }),
    ).resolves.toMatchObject({
      workspaceId: 'ws-alpha',
      name: 'Pilot Alpha',
    });

    expect(prisma.db.brandBrief.upsert).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-alpha' },
      create: {
        workspaceId: 'ws-alpha',
        name: 'Pilot Alpha',
        tone: 'clear',
        approvedFacts: 'Ships in 19 days.',
        prohibitedClaims: 'No unlimited scale.',
      },
      update: {
        name: 'Pilot Alpha',
        tone: 'clear',
        approvedFacts: 'Ships in 19 days.',
        prohibitedClaims: 'No unlimited scale.',
      },
    });
  });
});
