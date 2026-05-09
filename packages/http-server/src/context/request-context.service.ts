import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import rTracer from 'cls-rtracer';
import type { FastifyRequest } from 'fastify';

import type { IRequestBodySummary, IRequestData } from '../http-server.types';

@Injectable({
  scope: Scope.REQUEST,
})
export class RequestContextService {
  constructor(
    @Inject(REQUEST)
    public readonly request: FastifyRequest & FastifyRequest['raw'],
  ) {}

  private getBodySummary(body: unknown): IRequestBodySummary | undefined {
    if (body === undefined || body === null) {
      return undefined;
    }

    if (typeof body === 'string') {
      return { type: 'string', size: Buffer.byteLength(body) };
    }

    if (Buffer.isBuffer(body)) {
      return { type: 'buffer', size: body.length };
    }

    if (Array.isArray(body)) {
      return { type: 'array', itemsCount: body.length };
    }

    if (typeof body === 'object') {
      return { type: 'object', keysCount: Object.keys(body).length };
    }

    return { type: typeof body };
  }

  public getRequestData(): IRequestData {
    const requestId = (rTracer?.id() as string) || '';

    return {
      requestId,
      ip: this.request.ip,
      method: this.request.method,
      bodySummary: this.getBodySummary(this.request.body),
      url: this.request.originalUrl,
      ...((this.request as unknown as Record<string, unknown>).__contextData ||
        {}),
    };
  }
}
