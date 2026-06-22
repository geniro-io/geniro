import { describe, expect, it } from 'vitest';

import {
  deriveSdkToolTitle,
  formatDurationMs,
  summarizeWorkItems,
  type WorkSummaryItem,
} from './threadMessagesViewUtils';

describe('formatDurationMs', () => {
  it('returns em-dash for non-finite or non-positive', () => {
    expect(formatDurationMs(Number.NaN)).toBe('—');
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatDurationMs(0)).toBe('—');
    expect(formatDurationMs(-100)).toBe('—');
  });

  it('renders sub-second durations in ms', () => {
    expect(formatDurationMs(120)).toBe('120ms');
    expect(formatDurationMs(999)).toBe('999ms');
  });

  it('renders sub-minute durations as whole seconds', () => {
    expect(formatDurationMs(2_600)).toBe('3s');
    expect(formatDurationMs(3_400)).toBe('3s');
    expect(formatDurationMs(3_700)).toBe('4s');
    expect(formatDurationMs(45_000)).toBe('45s');
  });

  it('renders minute durations with minute + second split', () => {
    expect(formatDurationMs(83_000)).toBe('1m 23s');
    expect(formatDurationMs(302_000)).toBe('5m 2s');
  });

  it('renders whole-minute durations without the seconds suffix', () => {
    expect(formatDurationMs(120_000)).toBe('2m');
  });

  it('rolls seconds over to the next minute instead of rendering "5m 60s"', () => {
    // 359.5s previously rendered as "5m 60s" because Math.floor(/60) and
    // Math.round(%60) disagreed at the rollover boundary.
    expect(formatDurationMs(359_500)).toBe('6m');
    // 59.5s should bubble up to "1m", not "0m 60s".
    expect(formatDurationMs(59_500)).toBe('1m');
  });
});

describe('deriveSdkToolTitle', () => {
  it('builds "verb + primary arg" labels for the common SDK tools', () => {
    expect(
      deriveSdkToolTitle('Write', { file_path: '/runtime-workspace/hello.js' }),
    ).toBe('Write /runtime-workspace/hello.js');
    expect(deriveSdkToolTitle('Read', { file_path: '/etc/hosts' })).toBe(
      'Read /etc/hosts',
    );
    expect(deriveSdkToolTitle('Edit', { file_path: 'src/app.ts' })).toBe(
      'Edit src/app.ts',
    );
    expect(deriveSdkToolTitle('Bash', { command: 'node hello.js' })).toBe(
      'Run node hello.js',
    );
    expect(deriveSdkToolTitle('Grep', { pattern: 'TODO' })).toBe('Search TODO');
  });

  it('accepts a JSON-string args payload', () => {
    expect(deriveSdkToolTitle('Write', '{"file_path":"/tmp/a.txt"}')).toBe(
      'Write /tmp/a.txt',
    );
  });

  it('returns a fixed label for TodoWrite (no primary arg)', () => {
    expect(deriveSdkToolTitle('TodoWrite', { todos: [] })).toBe(
      'Update to-dos',
    );
  });

  it('returns undefined for unknown tools or a missing primary arg (falls back to name)', () => {
    expect(deriveSdkToolTitle('subagents_run_task', { purpose: 'x' })).toBe(
      undefined,
    );
    expect(deriveSdkToolTitle('Write', {})).toBe(undefined);
    expect(deriveSdkToolTitle('Write', undefined)).toBe(undefined);
    expect(deriveSdkToolTitle(undefined, { file_path: 'x' })).toBe(undefined);
  });

  it('truncates an over-long label', () => {
    const longPath = '/'.padEnd(300, 'a');
    const title = deriveSdkToolTitle('Write', { file_path: longPath });
    expect(title).toBeDefined();
    expect(title!.length).toBeLessThanOrEqual(120);
    expect(title!.endsWith('…')).toBe(true);
  });
});

describe('summarizeWorkItems', () => {
  const tool = (
    name: string,
    toolKind?: 'generic' | 'shell',
  ): WorkSummaryItem => ({
    type: 'tool',
    name,
    toolKind,
  });

  it('counts and pluralizes file writes', () => {
    expect(summarizeWorkItems([tool('write_file'), tool('write_file')])).toBe(
      'Wrote 2 files',
    );
    expect(summarizeWorkItems([tool('write_file')])).toBe('Wrote 1 file');
  });

  it('groups MCP calls by server with a friendly name', () => {
    expect(
      summarizeWorkItems([
        tool('mcp__linear__get_issue'),
        tool('mcp__linear__list_issues'),
        tool('mcp__linear__create_comment'),
      ]),
    ).toBe('Called Linear 3 times');
  });

  it('joins distinct categories in first-seen order with a middot', () => {
    expect(
      summarizeWorkItems([
        tool('write_file'),
        tool('write_file'),
        tool('mcp__linear__get_issue'),
      ]),
    ).toBe('Wrote 2 files · Called Linear 1 time');
  });

  it('treats shell tools (by kind or name) as commands', () => {
    expect(summarizeWorkItems([tool('exec', 'shell')])).toBe('Ran 1 command');
    expect(summarizeWorkItems([tool('run_terminal_cmd'), tool('bash')])).toBe(
      'Ran 2 commands',
    );
  });

  it('summarizes a reasoning-only block as a thinking line', () => {
    expect(summarizeWorkItems([{ type: 'reasoning' }])).toBe(
      'Thought for a moment',
    );
  });

  it('falls back to a neutral label while running with no tools yet', () => {
    expect(
      summarizeWorkItems([{ type: 'reasoning' }], { isRunning: true }),
    ).toBe('Working…');
    expect(summarizeWorkItems([])).toBe('Working…');
  });

  it('ignores reasoning when tools are present', () => {
    expect(summarizeWorkItems([{ type: 'reasoning' }, tool('read_file')])).toBe(
      'Read 1 file',
    );
  });
});
