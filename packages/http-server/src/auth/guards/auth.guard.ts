import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { UnauthorizedException } from '@packages/common';

import { AuthContextService } from '../auth-context.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private contextService: AuthContextService) {}

  async canActivate(_context: ExecutionContext) {
    if (!this.contextService.isAuthorized) {
      throw new UnauthorizedException();
    }

    return true;
  }
}
