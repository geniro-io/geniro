/* eslint-disable @typescript-eslint/naming-convention -- internal counter needs leading underscore */
import { Injectable } from '@nestjs/common';

import type { RuntimeExecResult } from '../../../../v1/runtime/runtime.types';
import {
  MockRuntimeExecFixture,
  MockRuntimeExecMatcher,
  MockRuntimeExecReply,
  MockRuntimeExecRequest,
} from './mock-runtime.types';

/**
 * In-memory mock for the `BaseRuntime` exec layer.
 *
 * ### Resolution order
 * 1. Registered fixtures (`onExec`) — every fixture whose matcher fields all
 *    match the request is a candidate. The most-specific candidate wins
 *    (count of non-undefined matcher fields). Ties are broken by registration
 *    order.
 * 2. Built-in fallbacks for common commands (see `applyBuiltinFallback`).
 * 3. Default success — `{ fail: false, exitCode: 0, stdout: '', stderr: '',
 *    execPath: 'mock' }`.
 *
 * ### Request log
 * Every call to `resolveExec()` appends the request before resolution so even
 * dynamic-reply fixtures show up in `getRequests()`.
 */

@Injectable()
export class MockRuntimeService {
  private execFixtures: MockRuntimeExecFixture[] = [];
  private requestLog: MockRuntimeExecRequest[] = [];
  private hostnameCounter = 0;
  private _callIndex = 0;
  /**
   * When true, a request that hits no fixture and no built-in fallback throws
   * instead of returning the default success. Useful for tests that want to
   * assert the exact set of commands they expect.
   */
  private strict = false;

  // ---------------------------------------------------------------------------
  // Public registration API
  // ---------------------------------------------------------------------------

  /** Register a fixture for an exec call. */
  public onExec(
    matcher: MockRuntimeExecMatcher,
    reply: MockRuntimeExecReply,
  ): void {
    this.execFixtures.push({ matcher, reply });
  }

  /** Toggle strict mode — see class-level comment. */
  public setStrict(strict: boolean): void {
    this.strict = strict;
  }

  // ---------------------------------------------------------------------------
  // Request log access
  // ---------------------------------------------------------------------------

  public getRequests(): MockRuntimeExecRequest[] {
    return [...this.requestLog];
  }

  public getLastRequest(): MockRuntimeExecRequest | undefined {
    return this.requestLog.at(-1);
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  public reset(): void {
    this.execFixtures = [];
    this.requestLog = [];
    this._callIndex = 0;
    this.strict = false;
  }

  // ---------------------------------------------------------------------------
  // Internal API used by MockRuntime
  // ---------------------------------------------------------------------------

  /**
   * Returns the next sequential hostname. Each MockRuntime instance gets a
   * fresh hostname so tests that assert "hostname changed after revision"
   * naturally observe a new value.
   */
  public allocateHostname(): string {
    this.hostnameCounter += 1;
    return `mock-runtime-${this.hostnameCounter.toString(16).padStart(12, '0')}`;
  }

  public resolveExec(
    request: Omit<MockRuntimeExecRequest, 'callIndex'>,
  ): RuntimeExecResult | { __hangUntilAbort: true } {
    const fullRequest: MockRuntimeExecRequest = {
      ...request,
      callIndex: this._callIndex++,
    };
    this.requestLog.push(fullRequest);

    const reply = this.findFixture(fullRequest);
    if (reply !== undefined) {
      const partial = typeof reply === 'function' ? reply(fullRequest) : reply;
      if (partial.hangUntilAbort) {
        return { __hangUntilAbort: true };
      }
      return this.materializeReply(partial, fullRequest);
    }

    const fallback = this.applyBuiltinFallback(fullRequest);
    if (fallback !== undefined) {
      return fallback;
    }

    if (this.strict) {
      throw new Error(
        `MockRuntime: no fixture matched command "${fullRequest.cmdString}"`,
      );
    }

    return {
      fail: false,
      exitCode: 0,
      stdout: '',
      stderr: '',
      execPath: 'mock',
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private findFixture(
    request: MockRuntimeExecRequest,
  ): MockRuntimeExecReply | undefined {
    const candidates = this.execFixtures.filter((f) =>
      this.fixtureMatches(f.matcher, request),
    );

    if (candidates.length === 0) {
      return undefined;
    }

    const best = candidates.reduce((winner, current) =>
      this.specificity(current.matcher) > this.specificity(winner.matcher)
        ? current
        : winner,
    );

    return best.reply;
  }

  private specificity(matcher: MockRuntimeExecMatcher): number {
    let score = 0;
    for (const value of Object.values(matcher)) {
      if (value !== undefined) {
        score += 1;
      }
    }
    return score;
  }

  private fixtureMatches(
    matcher: MockRuntimeExecMatcher,
    request: MockRuntimeExecRequest,
  ): boolean {
    if (matcher.cmd !== undefined) {
      if (!this.matchString(matcher.cmd, request.cmdString, true)) {
        return false;
      }
    }
    if (matcher.cwd !== undefined && matcher.cwd !== request.cwd) {
      return false;
    }
    if (matcher.runtimeHostname !== undefined) {
      if (
        !this.matchString(
          matcher.runtimeHostname,
          request.runtimeHostname,
          true,
        )
      ) {
        return false;
      }
    }
    return true;
  }

  private matchString(
    pattern: string | RegExp,
    value: string,
    substring: boolean,
  ): boolean {
    if (pattern instanceof RegExp) {
      return pattern.test(value);
    }
    return substring ? value.includes(pattern) : value === pattern;
  }

  private materializeReply(
    partial: Partial<RuntimeExecResult> & { hangUntilAbort?: boolean },
    _request: MockRuntimeExecRequest,
  ): RuntimeExecResult {
    const exitCode = partial.exitCode ?? 0;
    return {
      fail: partial.fail ?? exitCode !== 0,
      exitCode,
      stdout: partial.stdout ?? '',
      stderr: partial.stderr ?? '',
      execPath: partial.execPath ?? 'mock',
      ...(partial.timeout !== undefined ? { timeout: partial.timeout } : {}),
    };
  }

  /**
   * Built-in fallbacks for commands the production code emits frequently.
   * Implements just enough mini-shell to keep simple integration tests
   * working without per-test fixtures:
   *
   * - `cat /etc/hostname` returns the runtime instance's hostname.
   * - `echo …` returns the echoed text, with `$VAR` expanded from
   *   `request.env`. Single quotes do NOT expand; double or no quotes do.
   * - `printenv FOO` returns the value of `FOO` from `request.env`, or
   *   empty stdout with exitCode 1 if unset.
   * - `;` and `&&` chain segments by running each through the same handler
   *   and concatenating stdout. `&&` short-circuits on a non-zero segment.
   *
   * Anything else falls through to the caller's default success reply.
   */
  private applyBuiltinFallback(
    request: MockRuntimeExecRequest,
  ): RuntimeExecResult | undefined {
    const env = request.env ?? {};
    const result = this.runMockShell(request.cmdString.trim(), {
      env,
      hostname: request.runtimeHostname,
    });
    return result;
  }

  private runMockShell(
    cmd: string,
    ctx: { env: Record<string, string>; hostname: string },
  ): RuntimeExecResult | undefined {
    const segments = this.splitChain(cmd);
    if (segments.length === 0) {
      return undefined;
    }

    const stdoutParts: string[] = [];
    let lastExitCode = 0;

    for (const segment of segments) {
      if (segment.skipIfPrevFailed && lastExitCode !== 0) {
        continue;
      }
      const piece = this.runMockShellSegment(segment.cmd, ctx);
      if (piece === undefined) {
        // Unrecognized segment short-circuits the whole fallback.
        return undefined;
      }
      stdoutParts.push(piece.stdout);
      lastExitCode = piece.exitCode;
    }

    return {
      fail: lastExitCode !== 0,
      exitCode: lastExitCode,
      stdout: stdoutParts.join(''),
      stderr: '',
      execPath: 'mock',
    };
  }

  private splitChain(
    cmd: string,
  ): { cmd: string; skipIfPrevFailed: boolean }[] {
    // Naive split that respects neither nested quotes nor backslashes — fine
    // for the simple `echo "x"; echo $Y` and `cmd && cmd` cases tests use.
    const parts: { cmd: string; skipIfPrevFailed: boolean }[] = [];
    let buf = '';
    let i = 0;
    let inQuote: '"' | "'" | null = null;
    let skipNext = false;

    const flush = () => {
      const trimmed = buf.trim();
      if (trimmed) {
        parts.push({ cmd: trimmed, skipIfPrevFailed: skipNext });
      }
      buf = '';
    };

    while (i < cmd.length) {
      const ch = cmd[i];
      if (inQuote) {
        if (ch === inQuote) {
          inQuote = null;
        }
        buf += ch;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inQuote = ch;
        buf += ch;
        i += 1;
        continue;
      }
      if (ch === ';') {
        flush();
        skipNext = false;
        i += 1;
        continue;
      }
      if (ch === '&' && cmd[i + 1] === '&') {
        flush();
        skipNext = true;
        i += 2;
        continue;
      }
      buf += ch;
      i += 1;
    }
    flush();
    return parts;
  }

  private runMockShellSegment(
    segment: string,
    ctx: { env: Record<string, string>; hostname: string },
  ): { stdout: string; exitCode: number } | undefined {
    if (segment === 'cat /etc/hostname') {
      return { stdout: ctx.hostname + '\n', exitCode: 0 };
    }

    const echoMatch = segment.match(/^echo\s+(.*)$/);
    if (echoMatch && echoMatch[1] !== undefined) {
      const expanded = this.echoExpand(echoMatch[1], ctx.env);
      return { stdout: expanded + '\n', exitCode: 0 };
    }

    const printenvMatch = segment.match(/^printenv\s+(\S+)$/);
    if (printenvMatch && printenvMatch[1] !== undefined) {
      const value = ctx.env[printenvMatch[1]];
      if (value === undefined) {
        return { stdout: '', exitCode: 1 };
      }
      return { stdout: value + '\n', exitCode: 0 };
    }

    return undefined;
  }

  /**
   * Mimics shell `echo` quote semantics on the given argument tail:
   * - Single-quoted runs are emitted literally (no `$VAR` expansion).
   * - Double-quoted and unquoted runs expand `$VAR` and `${VAR}` from `env`.
   */
  private echoExpand(arg: string, env: Record<string, string>): string {
    let out = '';
    let i = 0;
    let inSingle = false;
    while (i < arg.length) {
      const ch = arg[i];
      if (ch === "'") {
        inSingle = !inSingle;
        i += 1;
        continue;
      }
      if (ch === '"') {
        i += 1;
        continue;
      }
      if (!inSingle && ch === '$') {
        if (arg[i + 1] === '{') {
          const close = arg.indexOf('}', i + 2);
          if (close !== -1) {
            const varName = arg.slice(i + 2, close);
            out += env[varName] ?? '';
            i = close + 1;
            continue;
          }
        }
        const m = arg.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
        if (m) {
          out += env[m[0]] ?? '';
          i += 1 + m[0].length;
          continue;
        }
      }
      out += ch;
      i += 1;
    }
    return out;
  }
}
