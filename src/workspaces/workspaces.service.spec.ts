import { ForbiddenException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from './workspaces.service';

describe('WorkspacesService', () => {
  const prisma = {
    db: {
      user: {
        update: jest.fn(),
      },
      membership: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
    },
  };

  const audit = {
    record: jest.fn().mockResolvedValue(null),
  };

  const service = new WorkspacesService(
    prisma as unknown as PrismaService,
    audit as never,
  );

  const workspaceAlpha = {
    id: 'ws-alpha',
    name: 'Pilot Alpha',
    slug: 'pilot-alpha',
  };
  const workspaceBeta = {
    id: 'ws-beta',
    name: 'Pilot Beta',
    slug: 'pilot-beta',
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('lists only workspaces belonging to the user and marks current workspace', async () => {
    prisma.db.membership.findMany.mockResolvedValue([
      {
        workspaceId: workspaceAlpha.id,
        userId: 'user-1',
        role: 'operator',
        workspace: workspaceAlpha,
      },
      {
        workspaceId: workspaceBeta.id,
        userId: 'user-1',
        role: 'admin',
        workspace: workspaceBeta,
      },
    ]);

    const result = await service.listWorkspaces('user-1', 'ws-alpha');

    expect(prisma.db.membership.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(result).toEqual([
      {
        id: 'ws-alpha',
        name: 'Pilot Alpha',
        slug: 'pilot-alpha',
        role: 'operator',
        isCurrent: true,
      },
      {
        id: 'ws-beta',
        name: 'Pilot Beta',
        slug: 'pilot-beta',
        role: 'admin',
        isCurrent: false,
      },
    ]);
  });

  it('switches to a valid workspace and updates the user record', async () => {
    prisma.db.membership.findFirst.mockResolvedValue({
      workspaceId: workspaceBeta.id,
      userId: 'user-1',
      role: 'admin',
      workspace: workspaceBeta,
    });
    prisma.db.user.update.mockResolvedValue({
      id: 'user-1',
      currentWorkspaceId: workspaceBeta.id,
    });

    const result = await service.switchWorkspace('user-1', workspaceBeta.id);

    expect(prisma.db.membership.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        workspaceId: workspaceBeta.id,
      },
      include: { workspace: true },
    });
    expect(prisma.db.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { currentWorkspaceId: workspaceBeta.id },
    });
    expect(result).toEqual({
      workspace: {
        id: 'ws-beta',
        name: 'Pilot Beta',
        slug: 'pilot-beta',
        role: 'admin',
      },
    });
  });

  it('rejects switching to a workspace the user does not belong to', async () => {
    prisma.db.membership.findFirst.mockResolvedValue(null);

    await expect(
      service.switchWorkspace('user-1', 'unauthorized-ws'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.db.user.update).not.toHaveBeenCalled();
  });
});
