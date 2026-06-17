import { readFile } from 'node:fs/promises';

import type { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';

import type { BaseRuntime } from '../../../runtime/services/base-runtime';
import { ClaudeBootstrapService } from './claude-bootstrap.service';

// Keep the bridge-install path independent of the built `dist/bridge.mjs`
// artifact: stub the FS read and the script-path resolver so the
// `ensureBridgeInstalled` install branch can be exercised in a unit test.
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => Buffer.from('bridge-source')),
}));
vi.mock('@packages/claude-bridge', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@packages/claude-bridge')>();
  return { ...actual, getBridgeScriptPath: vi.fn(() => '/fake/bridge.mjs') };
});

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

  describe('ensureBridgeInstalled', () => {
    it('returns the bridge path without installing when the marker is present', async () => {
      // Default mock: every exec (incl. the `test -f <marker>` probe) → 0.
      const { bridgePath } = await service.ensureSessionReady(runtime, {});

      expect(bridgePath).toContain('bridge.mjs');
      const installCall = exec.mock.calls.find((c) =>
        String(c[0]?.cmd).includes('npm install'),
      );
      expect(installCall).toBeUndefined();
    });

    it('rejects CLAUDE_RUNTIME_NO_NODE without installing when node/npm are absent', async () => {
      exec.mockImplementation(async (params: { cmd: string | string[] }) => {
        const cmd = Array.isArray(params.cmd)
          ? params.cmd.join(' && ')
          : params.cmd;
        if (cmd.includes('.installed-p')) {
          return { exitCode: 1, fail: false, stderr: '' };
        }
        if (cmd.includes('command -v node')) {
          return { exitCode: 1, fail: false, stderr: '' };
        }
        return { exitCode: 0, fail: false, stderr: '' };
      });

      await expect(
        service.ensureSessionReady(runtime, {}),
      ).rejects.toMatchObject({ errorCode: 'CLAUDE_RUNTIME_NO_NODE' });

      const installCall = exec.mock.calls.find((c) =>
        String(c[0]?.cmd).includes('npm install'),
      );
      expect(installCall).toBeUndefined();
    });

    it('streams the bridge in bounded chunks so no exec argument exceeds the kernel limit', async () => {
      // A realistic bridge bundle (~570 KB) base64-encodes to ~760 KB. Embedding
      // that in a single `sh -lc '<cmd>'` argument blows past the kernel's
      // per-argument limit (Linux MAX_ARG_STRLEN = 128 KiB) and the exec fails
      // with E2BIG ("argument list too long"). Force the large-payload path.
      vi.mocked(readFile).mockResolvedValueOnce(Buffer.alloc(580_000, 0x61));
      exec.mockImplementation(async (params: { cmd: string | string[] }) => {
        const cmd = Array.isArray(params.cmd)
          ? params.cmd.join(' && ')
          : params.cmd;
        // Marker absent → take the install branch; everything else succeeds.
        if (cmd.startsWith('test -f') && cmd.includes('.installed-p')) {
          return { exitCode: 1, fail: false, stderr: '' };
        }
        return { exitCode: 0, fail: false, stderr: '' };
      });

      await service.ensureSessionReady(runtime, {});

      // The runtime funnels every command through one `sh -lc <arg>`; that single
      // argument is the array joined with ` && `. No command may exceed 128 KiB.
      const PER_ARG_LIMIT = 128 * 1024;
      const joined = (cmd: string | string[]): string =>
        Array.isArray(cmd) ? cmd.join(' && ') : String(cmd);
      for (const call of exec.mock.calls) {
        expect(joined(call[0].cmd).length).toBeLessThanOrEqual(PER_ARG_LIMIT);
      }

      // The base64 is staged via multiple chunk writes — exactly one truncating
      // (`>`) write, the rest appends (`>>`) — never embedded whole.
      const chunkWrites = exec.mock.calls
        .map((c) => joined(c[0].cmd))
        .filter(
          (cmd) => cmd.includes("printf '%s'") && cmd.includes('.mjs.b64'),
        );
      expect(chunkWrites.length).toBeGreaterThan(1);
      expect(chunkWrites.filter((c) => !c.includes('>>'))).toHaveLength(1);

      // The install chain decodes the staged file and cleans it up rather than
      // piping an embedded payload through base64.
      const installCall = exec.mock.calls.find((c) =>
        joined(c[0].cmd).includes('npm install'),
      );
      expect(installCall).toBeDefined();
      const installCmd = joined(installCall![0].cmd);
      expect(installCmd).toContain('base64 -d');
      expect(installCmd).toContain('rm -f');
    });

    it('rejects CLAUDE_BRIDGE_INSTALL_FAILED with the stderr tail when install fails', async () => {
      exec.mockImplementation(async (params: { cmd: string | string[] }) => {
        const cmd = Array.isArray(params.cmd)
          ? params.cmd.join(' && ')
          : params.cmd;
        // The install command array ends with `touch <marker>`, so match the
        // install branch before the marker branch.
        if (cmd.includes('npm install')) {
          return {
            exitCode: 1,
            fail: true,
            stderr: 'npm ERR! network timeout',
          };
        }
        if (cmd.includes('command -v node')) {
          return { exitCode: 0, fail: false, stderr: '' };
        }
        if (cmd.startsWith('test -f') && cmd.includes('.installed-p')) {
          return { exitCode: 1, fail: false, stderr: '' };
        }
        return { exitCode: 0, fail: false, stderr: '' };
      });

      await expect(
        service.ensureSessionReady(runtime, {}),
      ).rejects.toMatchObject({
        errorCode: 'CLAUDE_BRIDGE_INSTALL_FAILED',
        message: expect.stringContaining('network timeout'),
      });
    });
  });

  describe('plugin repo URL validation', () => {
    const expectRejected = async (repoUrl: string) => {
      await expect(
        service.ensureSessionReady(runtime, { plugins: [{ repoUrl }] }),
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

        await service.ensureSessionReady(runtime, {
          plugins: [{ repoUrl: url }],
        });

        const cloneCall = exec.mock.calls.find((c) =>
          String(c[0]?.cmd).includes('git clone'),
        );
        expect(cloneCall).toBeDefined();
        const cmd = String(cloneCall![0].cmd);
        expect(cmd).toContain(`-- '${url}'`);
      },
    );
  });

  describe('plugin path validation', () => {
    it.each([
      ['parent traversal', '../../../etc'],
      ['embedded traversal', 'plugins/../../escape'],
      ['absolute path', '/etc/passwd'],
      ['shell metacharacters', "p'; rm -rf /"],
      ['command substitution', 'p$(id)'],
      ['leading dash', '-flag'],
      ['whitespace', 'my plugin'],
    ])('rejects %s without running any shell command', async (_label, path) => {
      await expect(
        service.ensureSessionReady(runtime, {
          plugins: [{ repoUrl: 'https://github.com/acme/plugins', path }],
        }),
      ).rejects.toMatchObject({ errorCode: 'CLAUDE_PLUGIN_REPO_INVALID' });
      expect(exec).not.toHaveBeenCalled();
    });

    it('appends a valid subpath to the clone directory in pluginPaths', async () => {
      mockCloneNeeded();

      const { pluginPaths } = await service.ensureSessionReady(runtime, {
        plugins: [
          {
            repoUrl: 'https://github.com/acme/plugins',
            path: 'plugins/reviewer/',
          },
        ],
      });

      expect(pluginPaths).toHaveLength(1);
      expect(pluginPaths[0]).toMatch(/\/plugins\/reviewer$/);
    });
  });

  describe('multiple plugins', () => {
    it('clones a shared repository once and returns one root per plugin', async () => {
      mockCloneNeeded();
      const repoUrl = 'https://github.com/acme/marketplace';

      const { pluginPaths } = await service.ensureSessionReady(runtime, {
        plugins: [
          { repoUrl, path: 'plugins/alpha' },
          { repoUrl, path: 'plugins/beta' },
        ],
      });

      const cloneCalls = exec.mock.calls.filter((c) =>
        String(c[0]?.cmd).includes('git clone'),
      );
      expect(cloneCalls).toHaveLength(1);
      expect(pluginPaths).toHaveLength(2);
      expect(pluginPaths[0]).toMatch(/\/plugins\/alpha$/);
      expect(pluginPaths[1]).toMatch(/\/plugins\/beta$/);
    });

    it('clones distinct repositories separately', async () => {
      mockCloneNeeded();

      const { pluginPaths } = await service.ensureSessionReady(runtime, {
        plugins: [
          { repoUrl: 'https://github.com/acme/one' },
          { repoUrl: 'https://github.com/acme/two', ref: 'v2' },
        ],
      });

      const cloneCalls = exec.mock.calls.filter((c) =>
        String(c[0]?.cmd).includes('git clone'),
      );
      expect(cloneCalls).toHaveLength(2);
      expect(pluginPaths).toHaveLength(2);
      expect(pluginPaths[0]).not.toBe(pluginPaths[1]);
    });

    it('clones the SAME repo twice when the ref differs (clone key includes ref)', async () => {
      mockCloneNeeded();
      const repoUrl = 'https://github.com/acme/plugins';

      const { pluginPaths } = await service.ensureSessionReady(runtime, {
        plugins: [{ repoUrl }, { repoUrl, ref: 'v2' }],
      });

      const cloneCalls = exec.mock.calls.filter((c) =>
        String(c[0]?.cmd).includes('git clone'),
      );
      expect(cloneCalls).toHaveLength(2);
      expect(pluginPaths).toHaveLength(2);
      expect(pluginPaths[0]).not.toBe(pluginPaths[1]);
    });

    it('preserves plugin order across interleaved repositories', async () => {
      mockCloneNeeded();
      const r1 = 'https://github.com/acme/one';
      const r2 = 'https://github.com/acme/two';

      const { pluginPaths } = await service.ensureSessionReady(runtime, {
        plugins: [
          { repoUrl: r1, path: 'plugins/a' },
          { repoUrl: r2 },
          { repoUrl: r1, path: 'plugins/b' },
        ],
      });

      expect(pluginPaths).toHaveLength(3);
      const [root0, root1, root2] = pluginPaths as [string, string, string];
      // Sub-paths are appended in entry order: a (0), bare r2 (1), b (2).
      expect(root0).toMatch(/\/[0-9a-f]{12}\/plugins\/a$/);
      expect(root2).toMatch(/\/[0-9a-f]{12}\/plugins\/b$/);
      // Entries 0 and 2 (same repo r1) share one clone dir; entry 1 (r2) differs.
      const r1Base = root0.replace(/\/plugins\/a$/, '');
      expect(root2.replace(/\/plugins\/b$/, '')).toBe(r1Base);
      expect(root1).not.toBe(r1Base);
      expect(root1).toMatch(/\/[0-9a-f]{12}$/);
    });

    it('redacts the repo URL and reports "./" for a no-path plugin missing plugin.json', async () => {
      exec.mockImplementation(async (params: { cmd: string | string[] }) => {
        const cmd = Array.isArray(params.cmd)
          ? params.cmd.join(' && ')
          : params.cmd;
        if (cmd.startsWith('test -d')) {
          return { exitCode: 1, fail: false, stderr: '' };
        }
        if (cmd.includes('.claude-plugin/plugin.json')) {
          return { exitCode: 1, fail: false, stderr: '' };
        }
        return { exitCode: 0, fail: false, stderr: '' };
      });

      await expect(
        service.ensureSessionReady(runtime, {
          plugins: [
            { repoUrl: 'https://x:ghp_SECRET123@github.com/acme/not-a-plugin' },
          ],
        }),
      ).rejects.toMatchObject({
        errorCode: 'CLAUDE_PLUGIN_INVALID',
        message: expect.stringContaining("'./'"),
      });
      await expect(
        service.ensureSessionReady(runtime, {
          plugins: [
            { repoUrl: 'https://x:ghp_SECRET123@github.com/acme/not-a-plugin' },
          ],
        }),
      ).rejects.toMatchObject({
        message: expect.not.stringContaining('ghp_SECRET123'),
      });
    });

    it('dedupes identical plugin entries', async () => {
      mockCloneNeeded();
      const plugin = { repoUrl: 'https://github.com/acme/plugins' };

      const { pluginPaths } = await service.ensureSessionReady(runtime, {
        plugins: [plugin, { ...plugin }],
      });

      expect(pluginPaths).toHaveLength(1);
      const cloneCalls = exec.mock.calls.filter((c) =>
        String(c[0]?.cmd).includes('git clone'),
      );
      expect(cloneCalls).toHaveLength(1);
    });

    it('throws CLAUDE_PLUGIN_INVALID when the plugin root has no plugin.json', async () => {
      exec.mockImplementation(async (params: { cmd: string | string[] }) => {
        const cmd = Array.isArray(params.cmd)
          ? params.cmd.join(' && ')
          : params.cmd;
        if (cmd.startsWith('test -d')) {
          return { exitCode: 1, fail: false, stderr: '' };
        }
        if (cmd.includes('.claude-plugin/plugin.json')) {
          return { exitCode: 1, fail: false, stderr: '' };
        }
        return { exitCode: 0, fail: false, stderr: '' };
      });

      await expect(
        service.ensureSessionReady(runtime, {
          plugins: [
            {
              repoUrl: 'https://x:ghp_SECRET123@github.com/acme/not-a-plugin',
              path: 'missing',
            },
          ],
        }),
      ).rejects.toMatchObject({
        errorCode: 'CLAUDE_PLUGIN_INVALID',
        // Error message echoes the repo URL — embedded creds must be redacted.
        message: expect.not.stringContaining('ghp_SECRET123'),
      });
    });
  });

  describe('credential redaction in logs', () => {
    it('redacts embedded tokens from the clone log line but not from the exec command', async () => {
      mockCloneNeeded();
      const url =
        'https://x-access-token:ghp_SECRET123@github.com/acme/private';

      await service.ensureSessionReady(runtime, {
        plugins: [{ repoUrl: url }],
      });

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
          plugins: [
            { repoUrl: 'https://x:ghp_SECRET123@github.com/acme/private' },
          ],
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
          plugins: [{ repoUrl: 'https://github.com/acme/plugins', ref }],
        }),
      ).rejects.toMatchObject({ errorCode: 'CLAUDE_PLUGIN_REPO_INVALID' });
    });

    it('accepts a normal branch ref and quotes it', async () => {
      mockCloneNeeded();

      await service.ensureSessionReady(runtime, {
        plugins: [
          { repoUrl: 'https://github.com/acme/plugins', ref: 'release/v1.2' },
        ],
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

  describe('configureGitAuth', () => {
    // The marker gate calls `test -f <marker>` first; a 0 there short-circuits
    // before the git/gh config exec. Make the marker absent so the config runs.
    const markerAbsent = () =>
      exec.mockImplementation(async (params: { cmd: string | string[] }) => {
        const cmd = Array.isArray(params.cmd)
          ? params.cmd.join(' && ')
          : params.cmd;
        if (cmd.startsWith('test -f') && cmd.includes('.git-auth-configured')) {
          return { exitCode: 1, fail: false, stderr: '' };
        }
        return { exitCode: 0, fail: false, stderr: '' };
      });
    // The config exec is the one carrying the credential helper — call[0] is now
    // the marker probe, so find the setup call by content.
    const setupCall = () =>
      exec.mock.calls.find((c) =>
        String(c[0]?.cmd).includes('credential.helper'),
      );

    it('installs the credential helper and a baseline git identity in one exec', async () => {
      markerAbsent();
      await service.configureGitAuth(runtime);

      const cmd = String(setupCall()![0].cmd);
      expect(cmd).toContain('credential.helper');
      expect(cmd).toContain('user.name "Geniro Bot"');
      expect(cmd).toContain('git_protocol https');
    });

    it('references GH_TOKEN lazily and never bakes a token into the command', async () => {
      markerAbsent();
      await service.configureGitAuth(runtime);

      // The helper must resolve ${GH_TOKEN} from the session env at git time,
      // not embed a resolved credential — the token lives only in the env, so
      // it must never reach the configured command (and thus never a log line).
      const cmd = String(setupCall()![0].cmd);
      expect(cmd).toContain('${GH_TOKEN}');
      expect(cmd).not.toMatch(/gh[ps]_/);
    });

    it('skips the git/gh config exec when the version marker is already present', async () => {
      // Default beforeEach mock: every exec (incl. the `test -f` marker probe)
      // returns 0 → the marker is present → only the probe runs.
      await service.configureGitAuth(runtime);

      expect(exec).toHaveBeenCalledTimes(1);
      expect(String(exec.mock.calls[0]![0].cmd)).toContain(
        '.git-auth-configured',
      );
      expect(setupCall()).toBeUndefined();
    });

    it('touches the marker last so it only lands after a successful config', async () => {
      markerAbsent();
      await service.configureGitAuth(runtime);

      const cmd = String(setupCall()![0].cmd);
      expect(cmd).toContain('touch ');
      // The touch is appended after the config commands in the same && chain.
      expect(cmd.indexOf('touch ')).toBeGreaterThan(cmd.indexOf('user.email'));
    });

    it('warns but does not throw when the git config exec fails', async () => {
      // Every exec → exitCode 1: the marker probe reads "absent" (1), so the
      // config exec runs and also fails (1) → warn path, no throw.
      exec.mockResolvedValue({ exitCode: 1, fail: true, stderr: 'boom' });

      await expect(service.configureGitAuth(runtime)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('native git/gh auth'),
      );
    });
  });
});
