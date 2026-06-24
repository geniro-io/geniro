import {
  BadRequestException,
  DefaultLogger,
  InternalException,
} from '@packages/common';
import type { FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { SecretsStoreService } from '../../secrets-store/services/secrets-store.service';
import { GitUserPatDao } from '../dao/git-user-pat.dao';
import { GitPatValidatorService } from './git-pat-validator.service';
import { GitUserPatService } from './git-user-pat.service';

const SECRET_NAME = 'github-pat';

describe('GitUserPatService', () => {
  let service: GitUserPatService;
  let dao: {
    getOne: ReturnType<typeof vi.fn>;
    upsertByUserId: ReturnType<typeof vi.fn>;
    hardDelete: ReturnType<typeof vi.fn>;
  };
  let secretsStore: {
    readUserSecret: ReturnType<typeof vi.fn>;
    putUserSecret: ReturnType<typeof vi.fn>;
    deleteUserSecret: ReturnType<typeof vi.fn>;
  };
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const ctx = new AppContextStorage({ sub: 'user-1' }, {
    headers: {},
  } as unknown as FastifyRequest);

  beforeEach(() => {
    dao = {
      getOne: vi.fn().mockResolvedValue(null),
      upsertByUserId: vi.fn().mockResolvedValue({}),
      hardDelete: vi.fn().mockResolvedValue(undefined),
    };
    secretsStore = {
      readUserSecret: vi.fn(),
      putUserSecret: vi.fn().mockResolvedValue(undefined),
      deleteUserSecret: vi.fn().mockResolvedValue(undefined),
    };
    service = new GitUserPatService(
      dao as unknown as GitUserPatDao,
      secretsStore as unknown as SecretsStoreService,
      new GitPatValidatorService(),
      {
        warn: vi.fn(),
        debug: vi.fn(),
        log: vi.fn(),
        error: vi.fn(),
      } as unknown as DefaultLogger,
    );
  });

  describe('putPat', () => {
    beforeEach(() => {
      fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ login: 'octocat' }),
        headers: { get: () => null },
      } as unknown as Response);
      // No prior stored value (a fresh save) — a confirmed-absent read.
      secretsStore.readUserSecret.mockResolvedValue({ found: false });
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('validates, writes OpenBao before the DB, and returns status (never the value)', async () => {
      const result = await service.putPat(ctx, '  ghp_token  ');

      expect(secretsStore.putUserSecret).toHaveBeenCalledWith(
        'user-1',
        SECRET_NAME,
        'ghp_token',
      );
      expect(dao.upsertByUserId).toHaveBeenCalledWith(
        'user-1',
        SECRET_NAME,
        expect.objectContaining({ login: 'octocat', tokenType: 'classic' }),
      );
      expect(result).toMatchObject({
        configured: true,
        login: 'octocat',
        tokenType: 'classic',
      });
      expect(result).not.toHaveProperty('token');
    });

    it('rejects an invalid token format BEFORE any GitHub call or store write', async () => {
      await expect(service.putPat(ctx, 'gho_oauth')).rejects.toThrow(
        BadRequestException,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(secretsStore.putUserSecret).not.toHaveBeenCalled();
    });

    it('rejects with BadRequestException when GitHub rejects the token, storing nothing', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => null },
      } as unknown as Response);

      await expect(service.putPat(ctx, 'ghp_token')).rejects.toThrow(
        BadRequestException,
      );
      expect(secretsStore.putUserSecret).not.toHaveBeenCalled();
      expect(dao.upsertByUserId).not.toHaveBeenCalled();
    });

    it('rejects with GITHUB_PAT_VALIDATION_FAILED when GitHub returns 200 but no login, storing nothing', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
        headers: { get: () => null },
      } as unknown as Response);

      let caught: unknown;
      try {
        await service.putPat(ctx, 'ghp_token');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect((caught as BadRequestException).code).toBe(
        'GITHUB_PAT_VALIDATION_FAILED',
      );
      expect(secretsStore.putUserSecret).not.toHaveBeenCalled();
      expect(dao.upsertByUserId).not.toHaveBeenCalled();
    });

    it('treats a rate-limited response (403 + x-ratelimit-remaining=0) as a transient failure, not a rejected token', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 403,
        headers: {
          get: (h: string) => (h === 'x-ratelimit-remaining' ? '0' : null),
        },
      } as unknown as Response);

      let caught: unknown;
      try {
        await service.putPat(ctx, 'ghp_token');
      } catch (e) {
        caught = e;
      }
      // Distinguished from GITHUB_PAT_UNAUTHORIZED so the user is not told to
      // rotate a valid credential.
      expect(caught).toBeInstanceOf(BadRequestException);
      expect((caught as BadRequestException).code).toBe(
        'GITHUB_PAT_VALIDATION_FAILED',
      );
      expect(secretsStore.putUserSecret).not.toHaveBeenCalled();
    });

    it('rolls the OpenBao write back when the DB upsert fails (deletes the orphan when there was no prior value)', async () => {
      dao.upsertByUserId.mockRejectedValue(new Error('db down'));

      await expect(service.putPat(ctx, 'ghp_token')).rejects.toThrow('db down');

      expect(secretsStore.putUserSecret).toHaveBeenCalled();
      expect(secretsStore.deleteUserSecret).toHaveBeenCalledWith(
        'user-1',
        SECRET_NAME,
      );
    });

    it('restores the prior OpenBao value on DB failure when one existed', async () => {
      secretsStore.readUserSecret.mockResolvedValue({
        found: true,
        value: 'ghp_prior',
      });
      dao.upsertByUserId.mockRejectedValue(new Error('db down'));

      await expect(service.putPat(ctx, 'ghp_token')).rejects.toThrow('db down');

      // The most recent putUserSecret restores the prior value (newest write).
      expect(secretsStore.putUserSecret).toHaveBeenLastCalledWith(
        'user-1',
        SECRET_NAME,
        'ghp_prior',
      );
      expect(secretsStore.deleteUserSecret).not.toHaveBeenCalled();
    });

    it('does NOT delete or restore on DB failure when the prior value could not be read (transient) — never destroys an unprovable prior', async () => {
      // A transient read failure must NOT be collapsed to "absent": deleting
      // here could destroy a still-valid prior PAT. The just-written orphan is
      // left in place (unreachable without a pointer row, overwritten next save).
      secretsStore.readUserSecret.mockRejectedValue(new Error('openbao down'));
      dao.upsertByUserId.mockRejectedValue(new Error('db down'));

      await expect(service.putPat(ctx, 'ghp_token')).rejects.toThrow('db down');

      // Only the single main write happened — no restore, no delete.
      expect(secretsStore.putUserSecret).toHaveBeenCalledTimes(1);
      expect(secretsStore.putUserSecret).toHaveBeenCalledWith(
        'user-1',
        SECRET_NAME,
        'ghp_token',
      );
      expect(secretsStore.deleteUserSecret).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('returns configured:false when no PAT row exists', async () => {
      dao.getOne.mockResolvedValue(null);
      expect(await service.getStatus(ctx)).toEqual({
        configured: false,
        login: null,
        tokenType: null,
        validatedAt: null,
      });
    });

    it('returns the row metadata (login/tokenType/validatedAt), never the value', async () => {
      dao.getOne.mockResolvedValue({
        secretName: SECRET_NAME,
        metadata: {
          login: 'octo',
          tokenType: 'fine-grained',
          validatedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      expect(await service.getStatus(ctx)).toEqual({
        configured: true,
        login: 'octo',
        tokenType: 'fine-grained',
        validatedAt: '2026-01-01T00:00:00.000Z',
      });
    });
  });

  describe('deletePat', () => {
    it('hard-deletes the row FIRST, then purges the OpenBao value', async () => {
      dao.getOne.mockResolvedValue({ secretName: SECRET_NAME });
      await service.deletePat(ctx);
      expect(dao.hardDelete).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(secretsStore.deleteUserSecret).toHaveBeenCalledWith(
        'user-1',
        SECRET_NAME,
      );
      // Order matters: the resolver keys off the row, so the row must be gone
      // before (or independent of) the best-effort purge. Reverse order would
      // brick git ops on a transient DB error (secret gone, row survives).
      expect(dao.hardDelete.mock.invocationCallOrder[0]!).toBeLessThan(
        secretsStore.deleteUserSecret.mock.invocationCallOrder[0]!,
      );
    });

    it('still removes the row when the best-effort OpenBao purge fails', async () => {
      dao.getOne.mockResolvedValue({ secretName: SECRET_NAME });
      secretsStore.deleteUserSecret.mockRejectedValue(
        new Error('openbao down'),
      );
      // The row is already gone, so a failed purge must not surface.
      await expect(service.deletePat(ctx)).resolves.toBeUndefined();
      expect(dao.hardDelete).toHaveBeenCalledWith({ userId: 'user-1' });
    });

    it('is a no-op when nothing is configured', async () => {
      dao.getOne.mockResolvedValue(null);
      await service.deletePat(ctx);
      expect(secretsStore.deleteUserSecret).not.toHaveBeenCalled();
      expect(dao.hardDelete).not.toHaveBeenCalled();
    });
  });

  describe('resolvePatToken', () => {
    it('returns null when the user has no PAT row (benign — caller falls back to the App)', async () => {
      dao.getOne.mockResolvedValue(null);
      expect(await service.resolvePatToken('user-1')).toBeNull();
    });

    it('returns the stored token when the row and OpenBao value are both present', async () => {
      dao.getOne.mockResolvedValue({ secretName: SECRET_NAME });
      secretsStore.readUserSecret.mockResolvedValue({
        found: true,
        value: 'ghp_stored',
      });
      expect(await service.resolvePatToken('user-1')).toBe('ghp_stored');
    });

    it('throws InternalException (fail-CLOSED) when the row is present but the value is CONFIRMED-ABSENT (corrupt)', async () => {
      dao.getOne.mockResolvedValue({ secretName: SECRET_NAME });
      secretsStore.readUserSecret.mockResolvedValue({ found: false });
      await expect(service.resolvePatToken('user-1')).rejects.toThrow(
        InternalException,
      );
    });

    it('returns null (App fallback) when the row is present but the store fails TRANSIENTLY — never bricks git on an OpenBao blip', async () => {
      dao.getOne.mockResolvedValue({ secretName: SECRET_NAME });
      secretsStore.readUserSecret.mockRejectedValue(
        new InternalException('SECRETS_STORE_GET_FAILED', 'openbao down'),
      );
      expect(await service.resolvePatToken('user-1')).toBeNull();
    });
  });
});
