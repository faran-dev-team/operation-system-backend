import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { MembershipRole } from '@prisma/client';

import type { AuthContext } from '../../identity/auth-context';
import { ROLES_KEY } from '../decorators/roles.decorator';

const ROLE_WEIGHTS: Record<MembershipRole, number> = {
  admin: 3,
  operator: 2,
  reviewer: 1,
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<MembershipRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ auth?: AuthContext }>();
    const userRole = request.auth?.workspace?.role;

    if (!userRole) {
      throw new ForbiddenException(
        'No active workspace membership found for this request.',
      );
    }

    // Role passes if it matches explicitly or if the user's role weight meets the minimum required role weight
    const minRequiredWeight = Math.min(
      ...requiredRoles.map((role) => ROLE_WEIGHTS[role] ?? 0),
    );
    const userWeight = ROLE_WEIGHTS[userRole] ?? 0;

    const hasPermission =
      requiredRoles.includes(userRole) || userWeight >= minRequiredWeight;

    if (!hasPermission) {
      throw new ForbiddenException(
        'Insufficient permissions for this workspace.',
      );
    }

    return true;
  }
}
