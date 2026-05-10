import type { IAppBootstrapperExtension } from '@packages/common';

import { AuthModule } from './auth.module';
import type { IAuthModuleParams } from './auth.types';
import { AuthContextService } from './auth-context.service';
import { AuthContextStorage } from './auth-context-storage';

export { AuthContextService, AuthContextStorage, AuthModule };
export * from './auth.types';
export * from './auth-context-data-builder';
export * from './decorators/context-data.decorator';
export * from './decorators/only-for-auth.decorator';
export * from './providers/auth.provider';
export * from './providers/auth0.provider';
export * from './providers/keycloak.provider';
export * from './providers/logto.provider';
export * from './providers/zitadel.provider';

export const buildAuthExtension = (
  params: IAuthModuleParams,
): IAppBootstrapperExtension => {
  return {
    modules: [AuthModule.forRoot(params)],
  };
};
