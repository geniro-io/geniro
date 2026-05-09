import { type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import z from 'zod';

import { ZodResponseInterceptor } from './zod-response.interceptor';

describe('ZodResponseInterceptor', () => {
  const createExecutionContext = (): ExecutionContext => {
    // Minimal mock sufficient for interceptor usage (only getHandler/getClass are used)
    return {
      getClass: () => ({}) as never,
      getHandler: () => ({}) as never,
      getArgs: () => [],
      getArgByIndex: () => undefined,
      switchToHttp: () => ({}) as never,
      switchToRpc: () => ({}) as never,
      switchToWs: () => ({}) as never,
      getType: () => 'http',
    } as unknown as ExecutionContext;
  };

  const createCallHandler = (value: unknown): CallHandler => ({
    handle: () => of(value),
  });

  it('returns only schema fields on success (drops extras)', async () => {
    const schema = z.object({ a: z.string(), b: z.number() }).strict();

    const reflector = new Reflector();
    // Spy to return Swagger-like metadata with Zod-powered DTO shape
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === 'swagger/apiResponse') {
        return {
          200: {
            type: { schema },
          },
        } as Record<string, unknown>;
      }
      return undefined;
    });

    const interceptor = new ZodResponseInterceptor(reflector);
    const ctx = createExecutionContext();

    const input = { a: 'ok', b: 42, extra: 'remove-me' };
    const out$ = interceptor.intercept(ctx, createCallHandler(input));

    const result = await new Promise<unknown>((resolve) =>
      out$.subscribe(resolve),
    );
    expect(result).toEqual({ a: 'ok', b: 42 });
    expect(result).not.toHaveProperty('extra');
  });

  it('on validation error, returns only keys present in schema (no extras)', async () => {
    const schema = z.object({ a: z.string(), b: z.number() }).strict();

    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === 'swagger/apiResponse') {
        return {
          200: {
            type: { schema },
          },
        } as Record<string, unknown>;
      }
      return undefined;
    });

    const interceptor = new ZodResponseInterceptor(reflector);
    const ctx = createExecutionContext();

    // Invalid: b should be number (string provided); also includes extraneous field
    const invalid = {
      a: 'ok',
      b: 'not-a-number',
      extra: 'remove-me',
    } as unknown;
    const out$ = interceptor.intercept(ctx, createCallHandler(invalid));

    const result = await new Promise<unknown>((resolve) =>
      out$.subscribe(resolve),
    );
    // Should pick only schema keys from original object
    expect(result).toEqual({ a: 'ok', b: 'not-a-number' });
    expect(result).not.toHaveProperty('extra');
  });
});
