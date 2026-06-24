import { DefaultLogger, InternalException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real SecretsStoreService reads OpenBao connection settings from the
// environment in isAvailable(); stub them so the store reports available and
// readUserSecret reaches the live fetch + body-parse path under test.
vi.mock('../../../environments', () => ({
  environment: {
    openbaoAddr: 'http://localhost:8200',
    openbaoToken: 'test-token',
  },
}));

import { SecretsStoreService } from '../../secrets-store/services/secrets-store.service';
import { GitUserPatDao } from '../dao/git-user-pat.dao';
import { GitPatValidatorService } from './git-pat-validator.service';
import { GitUserPatService } from './git-user-pat.service';

const SECRET_NAME = 'github-pat';

describe('GitUserPatService corrupt stored-value resolution (real SecretsStoreService)', () => {
  let service: GitUserPatService;
  let dao: { getOne: ReturnType<typeof vi.fn> };
  let secretsStore: SecretsStoreService;

  beforeEach(() => {
    dao = {
      getOne: vi.fn().mockResolvedValue({ secretName: SECRET_NAME }),
    };
    secretsStore = new SecretsStoreService({
      log: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as DefaultLogger);
    service = new GitUserPatService(
      dao as unknown as GitUserPatDao,
      secretsStore,
      new GitPatValidatorService(),
      {
        log: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as DefaultLogger,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fails CLOSED (throws InternalException) when the PAT row is present but the stored value is a corrupt 200 body — never silently falls back to the App and masks the corruption', async () => {
    // Documented contract (git-user-pat.service.ts resolvePatToken docstring):
    // "Row present, value CONFIRMED-ABSENT (404) OR CORRUPT → throws
    // InternalException (fail-CLOSED) ... rather than silently degrading to an
    // anonymous/App clone that would mask the corruption indefinitely."
    //
    // A 200-OK response whose body lacks a string value at data.data.value is
    // the corrupt case ("store has SOMETHING, but it is garbage"). The real
    // SecretsStoreService.extractSecretValue throws an InternalException on this
    // body — through the SAME channel as a transient/5xx failure — so
    // resolvePatToken's transient-fallback catch returns null instead of
    // surfacing the broken credential. That is the indefinite-masking failure
    // the fail-closed design exists to prevent.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: vi.fn().mockResolvedValue({ data: { data: { wrong: 'shape' } } }),
        text: vi.fn().mockResolvedValue(''),
      } as unknown as Response),
    );

    await expect(service.resolvePatToken('user-corrupt')).rejects.toThrow(
      InternalException,
    );
  });

  it('fails CLOSED (throws InternalException) when the stored value is an EMPTY STRING — a zero-length credential is corrupt, never a silent App fallback', async () => {
    // The empty-string sub-shape of corruption: extractSecretValue accepts ''
    // as a string, but '' is falsy in every PAT consumer, so left as
    // {found:true,''} it would silently degrade to the App/anonymous path. It
    // must fail closed like any other unreadable-but-present credential.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: vi.fn().mockResolvedValue({ data: { data: { value: '' } } }),
        text: vi.fn().mockResolvedValue(''),
      } as unknown as Response),
    );

    await expect(service.resolvePatToken('user-corrupt')).rejects.toThrow(
      InternalException,
    );
  });
});
