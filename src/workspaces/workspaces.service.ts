import { ForbiddenException, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listWorkspaces(userId: string, currentWorkspaceId?: string) {
    const memberships = await this.prisma.db.membership.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((membership) => ({
      id: membership.workspace.id,
      name: membership.workspace.name,
      slug: membership.workspace.slug,
      role: membership.role,
      isCurrent: membership.workspaceId === currentWorkspaceId,
    }));
  }

  async switchWorkspace(userId: string, workspaceId: string) {
    const membership = await this.prisma.db.membership.findFirst({
      where: {
        userId,
        workspaceId,
      },
      include: {
        workspace: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('Workspace was not found for this account.');
    }

    await this.prisma.db.user.update({
      where: { id: userId },
      data: { currentWorkspaceId: workspaceId },
    });

    await this.audit.record({
      workspaceId,
      actorId: userId,
      action: 'workspace.switched',
      resource: 'workspace',
      resourceId: workspaceId,
      payload: {
        slug: membership.workspace.slug,
        role: membership.role,
      },
    });

    return {
      workspace: {
        id: membership.workspace.id,
        name: membership.workspace.name,
        slug: membership.workspace.slug,
        role: membership.role,
      },
    };
  }
}
