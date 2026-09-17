import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AuthContext } from '../identity/auth-context';
import { CurrentAuth } from '../identity/current-auth.decorator';
import { AuditService } from './audit.service';

@Controller('audit-logs')
@UseGuards(RolesGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @Roles('admin')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100) : 50;
    return this.auditService.listWorkspaceLogs(auth.workspace.id, parsedLimit);
  }
}
