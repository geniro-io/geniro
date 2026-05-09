import { BaseLogger } from '@packages/common';
import type { FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IContextData } from '../auth.types';
import { AuthContextService } from '../auth-context.service';
import { AuthContextStorage } from '../auth-context-storage';
import { FetchContextDataMiddleware } from './fetch-context-data.middleware';

const EMPTY_REQUEST = { headers: {} } as FastifyRequest;

describe('FetchContextDataMiddleware', () => {
  let middleware: FetchContextDataMiddleware;
  let mockContextService: AuthContextService;
  let mockLogger: BaseLogger;

  beforeEach(() => {
    mockLogger = {
      error: vi.fn(),
    } as unknown as BaseLogger;

    mockContextService = {
      init: vi.fn(),
      contextStorage: vi.fn(),
    } as unknown as AuthContextService;

    middleware = new FetchContextDataMiddleware(mockContextService, mockLogger);
  });

  it('should set context data and storage on successful init', async () => {
    const mockContextData: IContextData = { sub: 'user-123' };
    const mockStorage = new AuthContextStorage(mockContextData, EMPTY_REQUEST);

    vi.mocked(mockContextService.init).mockResolvedValue(mockContextData);
    vi.mocked(mockContextService.contextStorage).mockReturnValue(mockStorage);

    const req: any = {};
    const res: any = {};
    const next = vi.fn();

    middleware.use(req, res, next);

    // Wait for promise to resolve
    await vi.waitFor(() => {
      expect(next).toHaveBeenCalled();
    });

    expect(req.__contextData).toBe(mockContextData);
    expect(req.__contextDataStorage).toBe(mockStorage);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('should set storage to empty context on error and still call next', async () => {
    const error = new Error('Token verification failed');
    const mockStorage = new AuthContextStorage(undefined, EMPTY_REQUEST);

    vi.mocked(mockContextService.init).mockRejectedValue(error);
    vi.mocked(mockContextService.contextStorage).mockReturnValue(mockStorage);

    const req: any = {};
    const res: any = {};
    const next = vi.fn();

    middleware.use(req, res, next);

    // Wait for promise to reject and error handler to run
    await vi.waitFor(() => {
      expect(next).toHaveBeenCalled();
    });

    expect(req.__contextData).toBeUndefined();
    expect(req.__contextDataStorage).toBe(mockStorage);
    expect(mockLogger.error).toHaveBeenCalledWith(
      error,
      'Cannot verify the token',
    );
  });

  it('should allow contextStorage to be called even when undefined', async () => {
    const error = new Error('No auth context');
    const mockStorage = new AuthContextStorage(undefined, EMPTY_REQUEST);

    vi.mocked(mockContextService.init).mockRejectedValue(error);
    vi.mocked(mockContextService.contextStorage).mockReturnValue(mockStorage);

    const req: any = {};
    const res: any = {};
    const next = vi.fn();

    middleware.use(req, res, next);

    await vi.waitFor(() => {
      expect(next).toHaveBeenCalled();
    });

    // Verify that we can call checkSub on the storage (it should throw properly)
    expect(() => req.__contextDataStorage.checkSub()).toThrow();
    expect(req.__contextDataStorage).toBeDefined();
  });
});
