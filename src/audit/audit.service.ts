import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { redactSecrets } from '../providers/credential-protection';

export interface RecordAuditEventInput {
  workspaceId: string;
  actorId: string;
  action: string;
  resource: string;
  resourceId?: string | null;
  payload?: Record<string, unknown> | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAuditEventInput) {
    const sanitizedPayload = input.payload
      ? (redactSecrets(input.payload) as Prisma.InputJsonValue)
      : undefined;

    try {
      return await this.prisma.db.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: input.action,
          resource: input.resource,
          resourceId: input.resourceId ?? null,
          payload: sanitizedPayload,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to record audit log for action "${input.action}" in workspace "${input.workspaceId}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  listWorkspaceLogs(workspaceId: string, limit = 50) {
    return this.prisma.db.auditLog.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        actor: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });
  }
}
