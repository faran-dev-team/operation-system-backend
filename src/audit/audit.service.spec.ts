import { AuditService } from './audit.service';
import type { PrismaService } from '../prisma/prisma.service';

describe('AuditService', () => {
  let service: AuditService;
  let mockPrisma: {
    db: {
      auditLog: {
        create: jest.Mock;
        findMany: jest.Mock;
      };
    };
  };

  beforeEach(() => {
    mockPrisma = {
      db: {
        auditLog: {
          create: jest.fn(),
          findMany: jest.fn(),
        },
      },
    };

    service = new AuditService(mockPrisma as unknown as PrismaService);
  });

  it('records an audit event with sanitized payload', async () => {
    mockPrisma.db.auditLog.create.mockResolvedValue({
      id: 'log-1',
      workspaceId: 'ws-1',
      actorId: 'user-1',
      action: 'brand_brief.updated',
      resource: 'brand_brief',
      resourceId: 'bb-1',
      payload: { name: 'Brand Alpha', apiKey: '[REDACTED]' },
      createdAt: new Date(),
    });

    const result = await service.record({
      workspaceId: 'ws-1',
      actorId: 'user-1',
      action: 'brand_brief.updated',
      resource: 'brand_brief',
      resourceId: 'bb-1',
      payload: {
        name: 'Brand Alpha',
        apiKey: 'super-secret-key-12345678901234',
        password: 'my-secret-password',
      },
    });

    expect(result).toBeDefined();
    expect(mockPrisma.db.auditLog.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws-1',
        actorId: 'user-1',
        action: 'brand_brief.updated',
        resource: 'brand_brief',
        resourceId: 'bb-1',
        payload: {
          name: 'Brand Alpha',
          apiKey: '[REDACTED]',
          password: '[REDACTED]',
        },
      },
    });
  });

  it('records an event when payload is omitted', async () => {
    mockPrisma.db.auditLog.create.mockResolvedValue({
      id: 'log-2',
      workspaceId: 'ws-1',
      actorId: 'user-1',
      action: 'workspace.switched',
      resource: 'workspace',
      resourceId: 'ws-1',
      payload: null,
      createdAt: new Date(),
    });

    await service.record({
      workspaceId: 'ws-1',
      actorId: 'user-1',
      action: 'workspace.switched',
      resource: 'workspace',
      resourceId: 'ws-1',
    });

    expect(mockPrisma.db.auditLog.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws-1',
        actorId: 'user-1',
        action: 'workspace.switched',
        resource: 'workspace',
        resourceId: 'ws-1',
        payload: undefined,
      },
    });
  });

  it('returns null and does not throw if database insertion fails', async () => {
    mockPrisma.db.auditLog.create.mockRejectedValue(new Error('DB failure'));

    const result = await service.record({
      workspaceId: 'ws-1',
      actorId: 'user-1',
      action: 'content_request.submitted',
      resource: 'content_request',
    });

    expect(result).toBeNull();
  });

  it('queries workspace logs scoped by workspaceId', async () => {
    mockPrisma.db.auditLog.findMany.mockResolvedValue([]);

    await service.listWorkspaceLogs('ws-1', 20);

    expect(mockPrisma.db.auditLog.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
      orderBy: { createdAt: 'desc' },
      take: 20,
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
  });
});
