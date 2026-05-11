import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { BaseLogger, Logger } from '@packages/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AuthContextService } from '../auth-context.service';

@Injectable()
export class FetchContextDataMiddleware implements NestMiddleware {
  constructor(
    private readonly contextService: AuthContextService,
    @Inject(Logger)
    private readonly logger: BaseLogger,
  ) {}

  use(
    req: FastifyRequest & Record<string, unknown>,
    res: FastifyReply,
    next: () => void,
  ) {
    this.contextService
      .init()
      .then((contextData) => {
        req.__contextData = contextData;
        req.__contextDataStorage = this.contextService.contextStorage();

        // Also store on raw request to avoid scope issues with request-scoped providers
        const rawReq = req as unknown as { raw?: Record<string, unknown> };
        if (rawReq.raw) {
          rawReq.raw.__contextData = contextData;
          rawReq.raw.__contextDataStorage = req.__contextDataStorage;
        }

        return next();
      })
      .catch((e) => {
        this.logger.error(<Error>e, 'Cannot verify the token');

        // Still set the storage even on error, so downstream code doesn't crash
        req.__contextData = undefined;
        req.__contextDataStorage = this.contextService.contextStorage();

        // Also store on raw request
        const rawReq = req as unknown as { raw?: Record<string, unknown> };
        if (rawReq.raw) {
          rawReq.raw.__contextData = undefined;
          rawReq.raw.__contextDataStorage = req.__contextDataStorage;
        }

        return next();
      });
  }
}
