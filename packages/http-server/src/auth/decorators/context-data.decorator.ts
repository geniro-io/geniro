import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { IContextData } from '../auth.types';
import { AuthContextStorage } from '../auth-context-storage';

export const CtxData = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): IContextData => {
    const request = ctx.switchToHttp().getRequest() as {
      __contextData: IContextData;
      raw?: {
        __contextData?: IContextData;
      };
    };

    // Try to get from request first, then fall back to raw request
    // This handles cases where request-scoped providers create different request objects
    return request.__contextData || request.raw?.__contextData;
  },
);

export const CtxStorage = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): AuthContextStorage<IContextData> => {
    const request = ctx.switchToHttp().getRequest() as {
      __contextDataStorage: AuthContextStorage<IContextData>;
      __contextData?: IContextData;
      raw?: {
        __contextDataStorage?: AuthContextStorage<IContextData>;
      };
    };

    // Try to get from request first, then fall back to raw request
    // This handles cases where request-scoped providers create different request objects
    return request.__contextDataStorage || request.raw?.__contextDataStorage;
  },
);
