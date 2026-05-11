import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@packages/common';

import type { IContextData } from '../auth.types';
import { REQUIRED_ROLES_KEY } from '../decorators/only-for-auth.decorator';

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<
      string[] | undefined
    >(REQUIRED_ROLES_KEY, [context.getHandler(), context.getClass()]);

    if (!requiredRoles?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest() as {
      __contextData?: IContextData;
      raw?: { __contextData?: IContextData };
    };

    const contextData = request.__contextData ?? request.raw?.__contextData;
    const userRoles = contextData?.roles;

    if (!Array.isArray(userRoles)) {
      throw new ForbiddenException(
        'ROLE_REQUIRED',
        'This action requires specific role privileges',
      );
    }

    const hasRequiredRole = requiredRoles.some((role) =>
      userRoles.includes(role),
    );

    if (!hasRequiredRole) {
      throw new ForbiddenException(
        'ROLE_REQUIRED',
        'This action requires specific role privileges',
      );
    }

    return true;
  }
}
