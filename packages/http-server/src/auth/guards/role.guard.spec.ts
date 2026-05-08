import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IContextData } from '../auth.types';
import { REQUIRED_ROLES_KEY } from '../decorators/only-for-auth.decorator';
import { RoleGuard } from './role.guard';

function createMockContext(contextData?: IContextData): ExecutionContext {
  const request = {
    __contextData: contextData,
  };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('RoleGuard', () => {
  let reflector: Reflector;
  let guard: RoleGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RoleGuard(reflector);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should allow access when no roles are required', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    const context = createMockContext({ sub: 'user-1', roles: [] });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access when required roles list is empty', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([]);

    const context = createMockContext({ sub: 'user-1', roles: [] });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access when user has the required admin role', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);

    const context = createMockContext({
      sub: 'user-1',
      roles: ['admin'],
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access when user has admin among multiple roles', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);

    const context = createMockContext({
      sub: 'user-1',
      roles: ['user', 'admin', 'editor'],
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should deny access when user lacks the required role', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);

    const context = createMockContext({
      sub: 'user-1',
      roles: ['user', 'editor'],
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should deny access when user has no roles', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);

    const context = createMockContext({ sub: 'user-1' });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should deny access when roles is an empty array', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);

    const context = createMockContext({
      sub: 'user-1',
      roles: [],
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should deny access when context data is undefined', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);

    const context = createMockContext(undefined);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should throw ForbiddenException with ROLE_REQUIRED error code', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);

    const context = createMockContext({
      sub: 'user-1',
      roles: ['user'],
    });

    try {
      guard.canActivate(context);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).code).toBe('ROLE_REQUIRED');
      expect((err as ForbiddenException).statusCode).toBe(403);
    }
  });

  it('should read context data from raw request as fallback', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);

    const request = {
      __contextData: undefined,
      raw: {
        __contextData: {
          sub: 'user-1',
          roles: ['admin'],
        },
      },
    };

    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access when any one of multiple required roles matches', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
      'admin',
      'moderator',
    ]);

    const context = createMockContext({
      sub: 'user-1',
      roles: ['moderator'],
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should deny access when none of multiple required roles match', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
      'admin',
      'moderator',
    ]);

    const context = createMockContext({
      sub: 'user-1',
      roles: ['user', 'editor'],
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should use reflector with correct metadata key', () => {
    const spy = vi
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(undefined);

    const context = createMockContext({ sub: 'user-1' });
    guard.canActivate(context);

    expect(spy).toHaveBeenCalledWith(REQUIRED_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
  });
});
