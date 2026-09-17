import { AuditController } from './audit.controller';
import type { AuditService } from './audit.service';
import type { AuthContext } from '../identity/auth-context';

describe('AuditController', () => {
  let controller: AuditController;
  let mockAuditService: {
    listWorkspaceLogs: jest.Mock;
  };

  const mockAuth: AuthContext = {
    user: {
      id: 'u-1',
      email: 'admin@example.com',
      name: 'Admin User',
      supabaseAuthId: 'sb-admin',
    },
    workspace: {
      id: 'ws-1',
      name: 'Pilot Alpha',
      slug: 'pilot-alpha',
      role: 'admin',
    },
  };

  beforeEach(() => {
    mockAuditService = {
      listWorkspaceLogs: jest.fn().mockResolvedValue([]),
    };
    controller = new AuditController(mockAuditService as unknown as AuditService);
  });

  it('calls listWorkspaceLogs with workspaceId and default limit', async () => {
    await controller.list(mockAuth);

    expect(mockAuditService.listWorkspaceLogs).toHaveBeenCalledWith('ws-1', 50);
  });

  it('parses custom limit', async () => {
    await controller.list(mockAuth, '25');

    expect(mockAuditService.listWorkspaceLogs).toHaveBeenCalledWith('ws-1', 25);
  });
});
