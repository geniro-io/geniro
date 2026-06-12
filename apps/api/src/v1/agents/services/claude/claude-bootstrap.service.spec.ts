import type { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';

import type { BaseRuntime } from '../../../runtime/services/base-runtime';
import { ClaudeBootstrapService } from './claude-bootstrap.service';

/**
 * The SAFE_GIT_URL / SAFE_GIT_REF / SAFE_SESSION_ID regexes are the only
 * barrier between user-controlled graph config and a root shell inside the
 * sandbox — every rejection case here is a security pin, not a style check.
 */
describe('ClaudeBootstrapService', () => {
  let exec: ReturnType<typeof vi.fn>;
  let runtime: BaseRuntime;
  let logger: ReturnType<typeof mockDeep<DefaultLogger>>;
  let service: ClaudeBootstrapService;

  beforeEach(() => {
    exec = vi.fn().mockResolvedValue({ exitCode: 0, fail: false, stderr: '' });
    runtime = { exec } as unknown as BaseRuntime;
    logger = mockDeep<DefaultLogger>();
    service = new ClaudeBootstrapService(logger);
  });

  /** Bridge marker present (no install), plugin dir absent (clone needed). */
  const mockCloneNeeded = () => {
    exec.mockImplementation(async (params: { cmd: string | string[] }) => {
      const cmd = Array.isArray(params.cmd)
        ? params.cmd.join(' && ')
        : params.cmd;
      if (cmd.startsWith('test -d')) {
        return { exitCode: 1, fail: false, stderr: '' };
      }
      return { exitCode: 0, fail: false, stderr: '' };
    });
  };

  describe('plugin repo URL validation', () => {
    const expectRejected = async (pluginRepoUrl: string) => {
      await expect(
        service.ensureSessionReady(runtime, { pluginRepoUrl }),
      ).rejects.toMatchObject({ errorCode: 'CLAUDE_PLUGIN_REPO_INVALID' });
    };

    it.each([
      ['shell metacharacters', "https://x.test/repo'; rm -rf /"],
      ['backticks', 'https://x.test/repo`id`'],
      ['command substitution', 'https://x.test/repo$(id)'],
      ['whitespace', 'https://x.test/re po'],
      ['single quotes', "https://x.test/'repo'"],
      ['git option injection via leading dash', '--upload-pack=touch${IFS}pwn'],
      ['ext transport (code exec)', 'ext::sh -c id'],
      ['file transport', 'file:///etc/passwd'],
      ['ssh scheme (not in allowlist)', 'ssh://host/repo'],
    ])('rejects %s', async (_label, url) => {
      await expectRejected(url);
      // Validation must fail BEFORE any shell command is constructed.
      const cloneCalls = exec.mock.calls.filter((c) =>
        String(c[0]?.cmd).includes('git clone'),
      );
      expect(cloneCalls).toHaveLength(0);
    });

    it.each([
      ['https URL', 'https://github.com/acme/claude-plugins'],
      ['https URL with .git', 'https://github.com/acme/claude-plugins.git'],
      ['scp-style ssh remote', 'git@github.com:acme/claude-plugins.git'],
    ])(
      'accepts %s and quotes it after `--` in the clone command',
      async (_label, url) => {
        // Marker present (bridge installed), plugin dir absent (clone needed).
        exec.mockImplementation(async (params: { cmd: string | string[] }) => {
          const cmd = Array.isArray(params.cmd)
            ? params.cmd.join(' && ')
            : params.cmd;
          if (cmd.startsWith('test -d')) {
            return { exitCode: 1, fail: false, stderr: '' };
          }
          return { exitCode: 0, fail: false, stderr: '' };
        });

        await service.ensureSessionReady(runtime, { pluginRepoUrl: url });

        const cloneCall = exec.mock.calls.find((c) =>
          String(c[0]?.cmd).includes('git clone'),
        );
        expect(cloneCall).toBeDefined();
        const cmd = String(cloneCall![0].cmd);
        expect(cmd).toContain(`-- '${url}'`);
      },
    );
  });

  describe('credential redaction in logs', () => {
    it('redacts embedded tokens from the clone log line but not from the exec command', async () => {
      mockCloneNeeded();
      const url =
        'https://x-access-token:ghp_SECRET123@github.com/acme/private';

      await service.ensureSessionReady(runtime, { pluginRepoUrl: url });

      const logLine = vi
        .mocked(logger.log)
        .mock.calls.map((c) => String(c[0]))
        .find((line) => line.includes('Cloning Claude plugin repo'));
      expect(logLine).toBeDefined();
      expect(logLine).not.toContain('ghp_SECRET123');
      expect(logLine).toContain('https://***@github.com/acme/private');

      // The actual clone command still needs the real credential.
      const cloneCall = exec.mock.calls.find((c) =>
        String(c[0]?.cmd).includes('git clone'),
      );
      expect(String(cloneCall![0].cmd)).toContain('ghp_SECRET123');
    });

    it('redacts URLs echoed in the clone failure error', async () => {
      exec.mockImplementation(async (params: { cmd: string | string[] }) => {
        const cmd = Array.isArray(params.cmd)
          ? params.cmd.join(' && ')
          : params.cmd;
        if (cmd.startsWith('test -d')) {
          return { exitCode: 1, fail: false, stderr: '' };
        }
        if (cmd.includes('git clone')) {
          return {
            exitCode: 128,
            fail: true,
            stderr:
              "fatal: unable to access 'https://x:ghp_SECRET123@github.com/acme/private': 403",
          };
        }
        return { exitCode: 0, fail: false, stderr: '' };
      });

      await expect(
        service.ensureSessionReady(runtime, {
          pluginRepoUrl: 'https://x:ghp_SECRET123@github.com/acme/private',
        }),
      ).rejects.toMatchObject({
        errorCode: 'CLAUDE_PLUGIN_CLONE_FAILED',
        message: expect.not.stringContaining('ghp_SECRET123'),
      });
    });
  });

  describe('plugin repo ref validation', () => {
    it.each([
      ['shell metacharacters', "v1'; rm -rf /"],
      ['command substitution', 'v$(id)'],
      ['whitespace', 'release 1'],
      ['leading dash option injection', '--force'],
    ])('rejects ref with %s', async (_label, ref) => {
      await expect(
        service.ensureSessionReady(runtime, {
          pluginRepoUrl: 'https://github.com/acme/plugins',
          pluginRepoRef: ref,
        }),
      ).rejects.toMatchObject({ errorCode: 'CLAUDE_PLUGIN_REPO_INVALID' });
    });

    it('accepts a normal branch ref and quotes it', async () => {
      mockCloneNeeded();

      await service.ensureSessionReady(runtime, {
        pluginRepoUrl: 'https://github.com/acme/plugins',
        pluginRepoRef: 'release/v1.2',
      });

      const cloneCall = exec.mock.calls.find((c) =>
        String(c[0]?.cmd).includes('git clone'),
      );
      expect(String(cloneCall![0].cmd)).toContain("--branch 'release/v1.2'");
    });
  });

  describe('isSessionResumable', () => {
    it('rejects session ids with path traversal without probing the runtime', async () => {
      const resumable = await service.isSessionResumable(
        runtime,
        '../../etc/passwd',
      );
      expect(resumable).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    });

    it('rejects session ids with shell metacharacters', async () => {
      expect(await service.isSessionResumable(runtime, 'a$(id)')).toBe(false);
      expect(await service.isSessionResumable(runtime, "a'b")).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    });

    it('probes the transcript glob for a well-formed session id', async () => {
      exec.mockResolvedValue({ exitCode: 0, fail: false, stderr: '' });
      const resumable = await service.isSessionResumable(
        runtime,
        '5b7bcc8e-1234-4abc-9def-001122334455',
      );
      expect(resumable).toBe(true);
      expect(exec).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: expect.stringContaining(
            '5b7bcc8e-1234-4abc-9def-001122334455.jsonl',
          ),
        }),
      );
    });
  });
});
