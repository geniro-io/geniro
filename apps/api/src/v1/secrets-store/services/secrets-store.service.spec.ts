import type { DefaultLogger } from '@packages/common';
import { InternalException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../environments', () => ({
  environment: {
    openbaoAddr: 'http://localhost:8200',
    openbaoToken: 'test-token',
  },
}));

import { SecretsStoreService } from './secrets-store.service';

function stubFetch(response: Partial<Response>) {
  const defaults: Response = {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(''),
  } as unknown as Response;

  const merged = { ...defaults, ...response };
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(merged as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const createMockLogger = () =>
  ({
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as DefaultLogger;

describe('SecretsStoreService', () => {
  let service: SecretsStoreService;
  let mockLogger: DefaultLogger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    service = new SecretsStoreService(mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('isAvailable', () => {
    it('returns true when openbaoAddr and openbaoToken are set', () => {
      expect(service.isAvailable()).toBe(true);
    });
  });

  describe('putSecret', () => {
    it('sends PUT request to the correct KV v2 data path', async () => {
      const fetchMock = stubFetch({ ok: true, status: 200 });

      await service.putSecret('proj-1', 'MY_SECRET', 'secret-value');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0]!;
      expect(url).toBe(
        'http://localhost:8200/v1/secret/data/projects/proj-1/MY_SECRET',
      );
      expect((options as RequestInit).method).toBe('PUT');
      expect(JSON.parse((options as RequestInit).body as string)).toEqual({
        data: { value: 'secret-value' },
      });
    });

    it('includes the vault token auth header', async () => {
      const fetchMock = stubFetch({ ok: true, status: 200 });

      await service.putSecret('proj-1', 'MY_SECRET', 'val');

      const [, options] = fetchMock.mock.calls[0]!;
      expect((options as RequestInit).headers).toMatchObject({
        'X-Vault-Token': 'test-token',
        'Content-Type': 'application/json',
      });
    });

    it('throws InternalException on non-ok response', async () => {
      stubFetch({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: vi.fn().mockResolvedValue('storage failure'),
      });

      await expect(
        service.putSecret('proj-1', 'MY_SECRET', 'val'),
      ).rejects.toThrow(InternalException);
    });

    it('logs error body at debug level on failure', async () => {
      stubFetch({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: vi.fn().mockResolvedValue('bad payload'),
      });

      await expect(
        service.putSecret('proj-1', 'MY_SECRET', 'val'),
      ).rejects.toThrow(InternalException);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('bad payload'),
      );
    });

    it('throws InternalException when service is unavailable', async () => {
      vi.spyOn(service, 'isAvailable').mockReturnValue(false);

      await expect(
        service.putSecret('proj-1', 'MY_SECRET', 'val'),
      ).rejects.toThrow(InternalException);
    });
  });

  describe('getSecret', () => {
    it('returns the value from the nested KV v2 response', async () => {
      stubFetch({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: { data: { value: 'my-secret-value' } },
        }),
      });

      const result = await service.getSecret('proj-1', 'MY_SECRET');

      expect(result).toBe('my-secret-value');
    });

    it('sends GET request to the correct KV v2 data path', async () => {
      const fetchMock = stubFetch({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: { data: { value: 'val' } },
        }),
      });

      await service.getSecret('proj-1', 'MY_SECRET');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0]!;
      expect(url).toBe(
        'http://localhost:8200/v1/secret/data/projects/proj-1/MY_SECRET',
      );
      expect((options as RequestInit).method).toBe('GET');
    });

    it('throws InternalException on 404 not found response', async () => {
      stubFetch({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: vi.fn().mockResolvedValue(''),
      });

      await expect(service.getSecret('proj-1', 'MISSING')).rejects.toThrow(
        InternalException,
      );
    });

    it('throws InternalException on 500 server error response', async () => {
      stubFetch({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: vi.fn().mockResolvedValue('vault error'),
      });

      await expect(service.getSecret('proj-1', 'MY_SECRET')).rejects.toThrow(
        InternalException,
      );
    });

    it('throws InternalException when vault returns malformed response body', async () => {
      stubFetch({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ unexpected: 'structure' }),
      });

      await expect(service.getSecret('proj-1', 'MY_SECRET')).rejects.toThrow(
        InternalException,
      );
    });

    it('throws InternalException when vault returns null body', async () => {
      stubFetch({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(null),
      });

      await expect(service.getSecret('proj-1', 'MY_SECRET')).rejects.toThrow(
        InternalException,
      );
    });

    it('throws InternalException when service is unavailable', async () => {
      vi.spyOn(service, 'isAvailable').mockReturnValue(false);

      await expect(service.getSecret('proj-1', 'MY_SECRET')).rejects.toThrow(
        InternalException,
      );
    });
  });

  describe('deleteSecret', () => {
    it('sends DELETE request to the KV v2 metadata path', async () => {
      const fetchMock = stubFetch({ ok: true, status: 204 });

      await service.deleteSecret('proj-1', 'MY_SECRET');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0]!;
      expect(url).toBe(
        'http://localhost:8200/v1/secret/metadata/projects/proj-1/MY_SECRET',
      );
      expect((options as RequestInit).method).toBe('DELETE');
    });

    it('includes the vault token auth header', async () => {
      const fetchMock = stubFetch({ ok: true, status: 204 });

      await service.deleteSecret('proj-1', 'MY_SECRET');

      const [, options] = fetchMock.mock.calls[0]!;
      expect((options as RequestInit).headers).toMatchObject({
        'X-Vault-Token': 'test-token',
      });
    });

    it('throws InternalException on non-ok response', async () => {
      stubFetch({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: vi.fn().mockResolvedValue('permission denied'),
      });

      await expect(service.deleteSecret('proj-1', 'MY_SECRET')).rejects.toThrow(
        InternalException,
      );
    });

    it('logs error body at debug level on failure', async () => {
      stubFetch({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: vi.fn().mockResolvedValue('vault crash'),
      });

      await expect(service.deleteSecret('proj-1', 'MY_SECRET')).rejects.toThrow(
        InternalException,
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('vault crash'),
      );
    });

    it('throws InternalException when service is unavailable', async () => {
      vi.spyOn(service, 'isAvailable').mockReturnValue(false);

      await expect(service.deleteSecret('proj-1', 'MY_SECRET')).rejects.toThrow(
        InternalException,
      );
    });
  });

  describe('putUserSecret', () => {
    it('sends PUT to the user-scoped KV v2 data path', async () => {
      const fetchMock = stubFetch({ ok: true, status: 200 });

      await service.putUserSecret('user-1', 'github-pat', 'ghp_value');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0]!;
      expect(url).toBe(
        'http://localhost:8200/v1/secret/data/users/user-1/github-pat',
      );
      expect((options as RequestInit).method).toBe('PUT');
      expect(JSON.parse((options as RequestInit).body as string)).toEqual({
        data: { value: 'ghp_value' },
      });
    });

    it('throws InternalException when the service is unavailable', async () => {
      vi.spyOn(service, 'isAvailable').mockReturnValue(false);
      await expect(
        service.putUserSecret('user-1', 'github-pat', 'ghp_value'),
      ).rejects.toThrow(InternalException);
    });
  });

  describe('getUserSecret', () => {
    it('reads the value from the user-scoped KV v2 data path', async () => {
      const fetchMock = stubFetch({
        ok: true,
        status: 200,
        json: vi
          .fn()
          .mockResolvedValue({ data: { data: { value: 'ghp_value' } } }),
      });

      const value = await service.getUserSecret('user-1', 'github-pat');

      expect(value).toBe('ghp_value');
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe(
        'http://localhost:8200/v1/secret/data/users/user-1/github-pat',
      );
    });
  });

  describe('readUserSecret', () => {
    // The load-bearing seam for the Q2 transient-vs-absent split: a {found}
    // return = "definitively unretrievable, NOT a store outage" (caller fails
    // CLOSED); a thrown InternalException = transient (caller may App-fallback).
    it('returns { found: true, value } on a 200 with a well-formed body', async () => {
      stubFetch({
        ok: true,
        status: 200,
        json: vi
          .fn()
          .mockResolvedValue({ data: { data: { value: 'ghp_value' } } }),
      });

      const result = await service.readUserSecret('user-1', 'github-pat');

      expect(result).toEqual({ found: true, value: 'ghp_value' });
    });

    it('returns { found: false } on a confirmed 404 (absent secret)', async () => {
      stubFetch({ ok: false, status: 404, statusText: 'Not Found' });

      const result = await service.readUserSecret('user-1', 'github-pat');

      expect(result).toEqual({ found: false });
    });

    it('returns { found: false } on a 200 with a corrupt/malformed body — fail-closed, NOT transient', async () => {
      // A 200 whose KV body has no string value at data.data.value is a corrupt
      // secret; it must map to {found:false} (so the resolver fails CLOSED) and
      // must NOT throw through the transient channel (which would mask it).
      stubFetch({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { data: { wrong: 'shape' } } }),
      });

      const result = await service.readUserSecret('user-1', 'github-pat');

      expect(result).toEqual({ found: false });
    });

    it('returns { found: false } on a 200 with an EMPTY-STRING value — a zero-length credential is corrupt, not "found"', async () => {
      // extractSecretValue accepts '' (it is a string), but a zero-length value
      // is unusable and never written by the validated put* path; it must fail
      // CLOSED rather than reach a consumer as a falsy "no PAT" → App fallback.
      stubFetch({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { data: { value: '' } } }),
      });

      const result = await service.readUserSecret('user-1', 'github-pat');

      expect(result).toEqual({ found: false });
    });

    it('THROWS InternalException on a network error / timeout (transient)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('network down')),
      );

      await expect(
        service.readUserSecret('user-1', 'github-pat'),
      ).rejects.toThrow(InternalException);
    });

    it('THROWS InternalException on a non-404 error status (e.g. 503 — transient)', async () => {
      stubFetch({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: vi.fn().mockResolvedValue('sealed'),
      });

      await expect(
        service.readUserSecret('user-1', 'github-pat'),
      ).rejects.toThrow(InternalException);
    });
  });

  describe('deleteUserSecret', () => {
    it('sends DELETE to the user-scoped KV v2 metadata path', async () => {
      const fetchMock = stubFetch({ ok: true, status: 204 });

      await service.deleteUserSecret('user-1', 'github-pat');

      const [url, options] = fetchMock.mock.calls[0]!;
      expect(url).toBe(
        'http://localhost:8200/v1/secret/metadata/users/user-1/github-pat',
      );
      expect((options as RequestInit).method).toBe('DELETE');
    });
  });
});
