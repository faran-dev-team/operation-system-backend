import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { MembershipRole } from '@prisma/client';

import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  function createMockContext(role?: MembershipRole): ExecutionContext {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({
          auth: role
            ? {
                user: { id: 'u-1', email: 'test@example.com' },
                workspace: { id: 'ws-1', role },
              }
            : undefined,
        }),
      }),
    } as unknown as ExecutionContext;
  }

  it('allows access if no roles are required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    const context = createMockContext('reviewer');
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows admin access when admin is required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);

    const context = createMockContext('admin');
    expect(guard.canActivate(context)).toBe(true);
  });

  it('forbids operator when admin is required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);

    const context = createMockContext('operator');
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('forbids reviewer when admin is required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);

    const context = createMockContext('reviewer');
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows admin and operator when operator is required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['operator']);

    expect(guard.canActivate(createMockContext('admin'))).toBe(true);
    expect(guard.canActivate(createMockContext('operator'))).toBe(true);
  });

  it('forbids reviewer when operator is required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['operator']);

    expect(() => guard.canActivate(createMockContext('reviewer'))).toThrow(
      ForbiddenException,
    );
  });

  it('allows all roles when reviewer is required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['reviewer']);

    expect(guard.canActivate(createMockContext('admin'))).toBe(true);
    expect(guard.canActivate(createMockContext('operator'))).toBe(true);
    expect(guard.canActivate(createMockContext('reviewer'))).toBe(true);
  });

  it('throws ForbiddenException if auth context has no role', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['operator']);

    const context = createMockContext(undefined);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
