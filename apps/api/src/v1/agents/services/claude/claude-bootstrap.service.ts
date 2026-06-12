import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Injectable } from '@nestjs/common';
import {
  BRIDGE_PROTOCOL_VERSION,
  CLAUDE_AGENT_SDK_VERSION,
  getBridgeScriptPath,
} from '@packages/claude-bridge';
import { BadRequestException, DefaultLogger } from '@packages/common';

import { BaseRuntime } from '../../../runtime/services/base-runtime';
import type { ClaudePluginSource } from './claude-session.types';
import { CLAUDE_INSTALL_DIR, CLAUDE_PLUGINS_DIR } from './claude-session.types';
import { redactGitUrl } from './claude-session.utils';

// Scheme-anchored: a bare character allowlist still admits git option
// injection (leading-dash "urls" like --upload-pack=...) and code-executing
// transports (ext::). Only https:// and git@host:path forms are accepted.
const SAFE_GIT_URL = /^(https:\/\/|git@)[\w@.:/~+-]+$/;
// Must start with a word character: a leading dash would be parsed as a git
// option by the `checkout '<ref>'` fallback (e.g. ref = "--force").
const SAFE_GIT_REF = /^\w[\w./-]*$/;
// Relative path inside a cloned repo. Character allowlist alone still admits
// `..` traversal (all chars are word/dot/slash), hence the explicit check at
// the validation site.
const SAFE_PLUGIN_PATH = /^\w[\w./-]*$/;
const SAFE_SESSION_ID = /^[\w-]+$/;

/**
 * Idempotent, per-container session bootstrap for Claude Agent threads:
 * ships the bridge script into the runtime, installs the Agent SDK (which
 * bundles the Claude Code CLI) next to it, and clones the configured plugin
 * repositories. All work happens INSIDE the sandbox; the API host never runs
 * the SDK. A marker file keyed on protocol + SDK version makes repeat calls
 * on a cached container a single `test -f` exec.
 */
@Injectable()
export class ClaudeBootstrapService {
  constructor(private readonly logger: DefaultLogger) {}

  async ensureSessionReady(
    runtime: BaseRuntime,
    options: { plugins?: ClaudePluginSource[] },
  ): Promise<{ bridgePath: string; pluginPaths: string[] }> {
    const plugins = options.plugins ?? [];
    // Fail on config errors before any shell command is constructed.
    for (const plugin of plugins) {
      this.validatePluginSource(plugin);
    }

    const bridgePath = await this.ensureBridgeInstalled(runtime);

    const pluginPaths: string[] = [];
    const clonedRepos = new Map<string, string>();
    for (const plugin of plugins) {
      // Shared repos clone once per (repoUrl, ref) pair.
      const cloneKey = `${plugin.repoUrl}@${plugin.ref ?? ''}`;
      let repoDir = clonedRepos.get(cloneKey);
      if (!repoDir) {
        repoDir = await this.ensurePluginRepo(
          runtime,
          plugin.repoUrl,
          plugin.ref,
        );
        clonedRepos.set(cloneKey, repoDir);
      }
      const pluginRoot = plugin.path
        ? `${repoDir}/${plugin.path.replace(/\/+$/, '')}`
        : repoDir;
      await this.assertPluginRoot(runtime, pluginRoot, plugin);
      if (!pluginPaths.includes(pluginRoot)) {
        pluginPaths.push(pluginRoot);
      }
    }

    return { bridgePath, pluginPaths };
  }

  private validatePluginSource(plugin: ClaudePluginSource): void {
    if (!SAFE_GIT_URL.test(plugin.repoUrl)) {
      throw new BadRequestException(
        'CLAUDE_PLUGIN_REPO_INVALID',
        'Plugin repository URL contains unsupported characters',
      );
    }
    if (plugin.ref && !SAFE_GIT_REF.test(plugin.ref)) {
      throw new BadRequestException(
        'CLAUDE_PLUGIN_REPO_INVALID',
        'Plugin repository ref contains unsupported characters',
      );
    }
    if (
      plugin.path &&
      (!SAFE_PLUGIN_PATH.test(plugin.path) || plugin.path.includes('..'))
    ) {
      throw new BadRequestException(
        'CLAUDE_PLUGIN_REPO_INVALID',
        'Plugin path must be a relative path inside the repository without traversal',
      );
    }
  }

  /**
   * A local SDK plugin is a directory holding `.claude-plugin/plugin.json`.
   * Probing it here turns a wrong `path` (or a marketplace-only repo) into a
   * clear config error instead of a session that silently loads nothing.
   */
  private async assertPluginRoot(
    runtime: BaseRuntime,
    pluginRoot: string,
    plugin: ClaudePluginSource,
  ): Promise<void> {
    const probe = await runtime.exec({
      cmd: `test -f '${pluginRoot}/.claude-plugin/plugin.json'`,
    });
    if (probe.exitCode !== 0) {
      throw new BadRequestException(
        'CLAUDE_PLUGIN_INVALID',
        `No Claude Code plugin at '${plugin.path ?? './'}' in ${redactGitUrl(plugin.repoUrl)} — expected .claude-plugin/plugin.json at the plugin root`,
      );
    }
  }

  /**
   * Resume-or-replay probe: the SDK resumes from a transcript on the
   * container filesystem, so a session survives exactly as long as the
   * container. False ⇒ the caller replays thread history into a fresh session.
   */
  async isSessionResumable(
    runtime: BaseRuntime,
    sessionId: string,
  ): Promise<boolean> {
    if (!SAFE_SESSION_ID.test(sessionId)) {
      return false;
    }
    const probe = await runtime.exec({
      cmd: `ls "$HOME"/.claude/projects/*/${sessionId}.jsonl >/dev/null 2>&1`,
    });
    return probe.exitCode === 0;
  }

  private async ensureBridgeInstalled(runtime: BaseRuntime): Promise<string> {
    const bridgePath = `${CLAUDE_INSTALL_DIR}/bridge.mjs`;
    const marker = `${CLAUDE_INSTALL_DIR}/.installed-p${BRIDGE_PROTOCOL_VERSION}-sdk${CLAUDE_AGENT_SDK_VERSION}`;

    const markerCheck = await runtime.exec({
      cmd: `test -f ${marker}`,
    });
    if (markerCheck.exitCode === 0) {
      return bridgePath;
    }

    const nodeCheck = await runtime.exec({
      cmd: 'command -v node && command -v npm',
    });
    if (nodeCheck.exitCode !== 0) {
      throw new BadRequestException(
        'CLAUDE_RUNTIME_NO_NODE',
        'Claude Agent requires a runtime image with node and npm available (the default runtime image provides them)',
      );
    }

    const bridgeSource = await readFile(getBridgeScriptPath());
    const bridgeBase64 = bridgeSource.toString('base64');

    this.logger.log(
      `Installing Claude bridge + Agent SDK ${CLAUDE_AGENT_SDK_VERSION} into runtime`,
    );
    const install = await runtime.exec({
      cmd: [
        `mkdir -p ${CLAUDE_INSTALL_DIR}`,
        `cd ${CLAUDE_INSTALL_DIR}`,
        `printf '%s' '${bridgeBase64}' | base64 -d > ${bridgePath}`,
        'npm init -y >/dev/null 2>&1 || true',
        `npm install --no-fund --no-audit --omit=dev @anthropic-ai/claude-agent-sdk@${CLAUDE_AGENT_SDK_VERSION}`,
        `touch ${marker}`,
      ],
      timeoutMs: 600_000,
      idleTimeoutMs: 300_000,
    });
    if (install.fail) {
      throw new BadRequestException(
        'CLAUDE_BRIDGE_INSTALL_FAILED',
        `Failed to install the Claude bridge into the runtime: ${install.stderr.slice(-500)}`,
      );
    }

    return bridgePath;
  }

  // Callers MUST pass a `url`/`ref` already cleared by `validatePluginSource`
  // (ensureSessionReady validates every plugin up front before any clone).
  private async ensurePluginRepo(
    runtime: BaseRuntime,
    url: string,
    ref?: string,
  ): Promise<string> {
    // Non-security checksum: stable directory name per (url, ref) pair.
    const dirName = createHash('sha256')
      .update(`${url}@${ref ?? ''}`)
      .digest('hex')
      .slice(0, 12);
    const dest = `${CLAUDE_PLUGINS_DIR}/${dirName}`;

    const existing = await runtime.exec({
      cmd: `test -d ${dest}/.git`,
    });
    if (existing.exitCode === 0) {
      return dest;
    }

    this.logger.log(
      `Cloning Claude plugin repo into runtime: ${redactGitUrl(url)}`,
    );
    // `--` ends git option parsing — defense-in-depth on top of SAFE_GIT_URL.
    const branchArg = ref ? `--branch '${ref}' ` : '';
    const clone = await runtime.exec({
      cmd:
        `mkdir -p ${CLAUDE_PLUGINS_DIR} && rm -rf ${dest} && ` +
        `(git clone --depth 1 ${branchArg}-- '${url}' ${dest} || ` +
        `(git clone -- '${url}' ${dest}${ref ? ` && git -C ${dest} checkout '${ref}'` : ''}))`,
      timeoutMs: 300_000,
      idleTimeoutMs: 120_000,
    });
    if (clone.fail) {
      throw new BadRequestException(
        'CLAUDE_PLUGIN_CLONE_FAILED',
        // git error output echoes the remote URL — redact embedded creds.
        `Failed to clone the plugin repository: ${redactGitUrl(clone.stderr.slice(-500))}`,
      );
    }

    return dest;
  }
}
