import isPlainObject from 'lodash/isPlainObject';
import type { JsonValue } from 'type-fest';

import type { MessagePayload } from './threadMessagesTypes';

// ────────────────────────────────────────────
// Token / price formatting
// ────────────────────────────────────────────

const tokenCountFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});

export const formatTokenCount = (value: number): string => {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return tokenCountFormatter.format(value);
};

export const formatRequestTokenCount = (value: number): string => {
  if (!Number.isFinite(value)) {
    return '—';
  }

  const formatTruncatedDecimal = (raw: number): string => {
    const truncated = Math.floor(raw * 10) / 10;
    const normalized = String(truncated).replace('.', ',');
    return normalized.endsWith(',0') ? normalized.slice(0, -2) : normalized;
  };

  if (value < 1000) {
    return formatTokenCount(value);
  }

  if (value < 1_000_000) {
    return `${formatTruncatedDecimal(value / 1000)}k`;
  }

  return `${formatTruncatedDecimal(value / 1_000_000)}m`;
};

const requestUsdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

export const formatRequestUsdShort = (amount?: number | null): string => {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return '$—';
  }
  const truncated = Math.floor(amount * 1000) / 1000;
  return requestUsdFormatter.format(truncated);
};

/** Formats a duration in milliseconds to a human-readable string.
 *  Examples: "3s", "45s", "1m 23s", "5m 2s" */
export const formatDurationMs = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '—';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const totalSecondsRounded = Math.round(ms / 1000);
  if (totalSecondsRounded < 60) {
    return `${totalSecondsRounded}s`;
  }
  const minutes = Math.floor(totalSecondsRounded / 60);
  const seconds = totalSecondsRounded % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
};

// ────────────────────────────────────────────
// Message payload helpers
// ────────────────────────────────────────────

const getMessageRecord = (
  payload?: MessagePayload,
): Record<string, unknown> | undefined => {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  return payload as unknown as Record<string, unknown>;
};

/**
 * Extracts and normalizes the `additionalKwargs` / `additional_kwargs` record
 * from a message payload. Returns `undefined` when none is present.
 */
export const getAdditionalKwargs = (
  payload?: MessagePayload,
): Record<string, unknown> | undefined => {
  const record = getMessageRecord(payload);
  if (!record) {
    return undefined;
  }

  const additional =
    (record.additionalKwargs as Record<string, unknown> | undefined) ??
    (record.additional_kwargs as Record<string, unknown> | undefined);

  return isPlainObject(additional)
    ? (additional as Record<string, unknown>)
    : undefined;
};

/** Extracts `durationMs` from `additionalKwargs.__requestUsage.durationMs`
 *  of a message payload.  Returns `undefined` when not available. */
export const extractDurationMs = (
  payload?: MessagePayload,
): number | undefined => {
  const additional = getAdditionalKwargs(payload);
  const reqUsage = additional?.__requestUsage;
  if (reqUsage && typeof reqUsage === 'object' && !Array.isArray(reqUsage)) {
    const dur = (reqUsage as Record<string, unknown>).durationMs;
    if (typeof dur === 'number' && dur > 0) {
      return dur;
    }
  }
  return undefined;
};

/** Extracts `__durationMs` from `additionalKwargs` of a tool message payload.
 *  Set by ShellTool on the ToolMessage to record shell execution time.
 *  Returns `undefined` when not available. */
export const extractShellDurationMs = (
  payload?: MessagePayload,
): number | undefined => {
  const additional = getAdditionalKwargs(payload);
  const dur = additional?.__durationMs;
  if (typeof dur === 'number' && dur > 0) {
    return dur;
  }
  return undefined;
};

export const getMessageValue = <T = unknown>(
  payload: MessagePayload | undefined,
  key: string,
): T | undefined => {
  const record = getMessageRecord(payload);
  if (!record) {
    return undefined;
  }
  return record[key] as T | undefined;
};

export const getMessageString = (
  payload: MessagePayload | undefined,
  key: string,
): string | undefined => {
  const value = getMessageValue(payload, key);
  return typeof value === 'string' ? value : undefined;
};

export const getMessageTitle = (
  payload?: MessagePayload,
): string | undefined => {
  const title = getMessageString(payload, 'title');
  if (title && title.trim().length > 0) {
    return title;
  }

  const legacy = getMessageString(payload, '__title');
  if (legacy && legacy.trim().length > 0) {
    return legacy;
  }

  return undefined;
};

export const extractToolErrorText = (
  resultContent: unknown,
): string | undefined => {
  if (!isPlainObject(resultContent)) {
    return undefined;
  }
  const record = resultContent as Record<string, unknown>;
  const errorValue = record.error;

  if (typeof errorValue === 'string') {
    const trimmed = errorValue.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (errorValue === null || errorValue === undefined) {
    return undefined;
  }

  try {
    const serialized = JSON.stringify(errorValue, null, 2);
    const trimmed = serialized.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    const asString = String(errorValue);
    const trimmed = asString.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
};

export const getMessageRunId = (
  payload?: MessagePayload,
): string | undefined => {
  const record = getMessageRecord(payload);
  if (!record) {
    return undefined;
  }

  const direct = (record.runId as unknown) ?? (record.run_id as unknown);
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }

  const additional =
    (record.additionalKwargs as Record<string, unknown> | undefined) ??
    (record.additional_kwargs as Record<string, unknown> | undefined);

  const normalizedAdditional = isPlainObject(additional)
    ? (additional as Record<string, unknown>)
    : undefined;

  const fromAdditional =
    normalizedAdditional &&
    ((normalizedAdditional.__runId as unknown) ??
      (normalizedAdditional.run_id as unknown) ??
      (normalizedAdditional.runId as unknown));

  if (typeof fromAdditional === 'string' && fromAdditional.length > 0) {
    return fromAdditional;
  }
  return undefined;
};

export const getToolMessageKey = (msg?: {
  id?: string;
  message?: MessagePayload;
  createdAt?: string;
}): string | undefined => {
  if (!msg) {
    return undefined;
  }
  if (msg.id) {
    return msg.id;
  }
  const messageLevelId = getMessageString(msg.message, 'id');
  if (messageLevelId) {
    return messageLevelId;
  }
  if (msg.createdAt) {
    return `created-${msg.createdAt}`;
  }
  const toolCallId = getMessageString(msg.message, 'toolCallId');
  if (toolCallId) {
    return `toolCall-${toolCallId}`;
  }
  return undefined;
};

export const isToolLikeRole = (role?: string): boolean => {
  if (!role) {
    return false;
  }
  return role === 'tool';
};

export const isErrorMessage = (message: {
  message?: MessagePayload;
}): boolean => {
  const additional = getAdditionalKwargs(message.message);
  return Boolean(additional?.__isErrorMessage);
};

// ────────────────────────────────────────────
// CSS injection
// ────────────────────────────────────────────

export const ensureThinkingIndicatorStyles = (() => {
  let injected = false;
  return () => {
    if (injected || typeof document === 'undefined') {
      return;
    }
    if (document.getElementById('messages-tab-thinking-style')) {
      injected = true;
      return;
    }
    const style = document.createElement('style');
    style.id = 'messages-tab-thinking-style';
    style.textContent = `
      @keyframes messages-tab-thinking-pulse {
        0% { opacity: 0.7; }
        50% { opacity: 1; }
        100% { opacity: 0.7; }
      }
    `;
    document.head.appendChild(style);
    injected = true;
  };
})();

// ────────────────────────────────────────────
// Style constants
// ────────────────────────────────────────────

export const fullHeightColumnStyle: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

export const centeredStateStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export const scrollContainerStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: '12px 16px',
};

export const messageBlockStyle: React.CSSProperties = {
  marginBottom: '15px',
};

// ────────────────────────────────────────────
// Color generation
// ────────────────────────────────────────────

export const generateColorFromNodeId = (nodeId: string): string => {
  let hash = 0;
  for (let i = 0; i < nodeId.length; i++) {
    hash = nodeId.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash;
  }

  const hue = Math.abs(hash % 360);
  const saturation = 70;
  const lightness = 50;

  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
};

// ────────────────────────────────────────────
// JSON / args helpers
// ────────────────────────────────────────────

export const parseJsonSafe = (value: string): unknown | null => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

export const argsToObject = (
  args?: string | Record<string, unknown>,
): Record<string, JsonValue> | null => {
  if (!args) {
    return null;
  }
  if (typeof args === 'string') {
    const parsed = parseJsonSafe(args);
    return isPlainObject(parsed) ? (parsed as Record<string, JsonValue>) : null;
  }
  if (isPlainObject(args)) {
    return args as Record<string, JsonValue>;
  }
  return null;
};

export const extractShellCommandFromArgs = (
  args?: string | Record<string, unknown>,
): string | undefined => {
  const obj = argsToObject(args);
  if (!obj) {
    return undefined;
  }
  if (typeof obj.command === 'string') {
    return obj.command;
  }
  if (typeof obj.cmd === 'string') {
    return obj.cmd;
  }
  return undefined;
};

// Claude Agent SDK built-in tools arrive with only their bare name (`Write`,
// `Bash`, …) and no human-readable title — unlike Geniro tools, whose backend
// sets a title on the message. Synthesize a concise "verb + primary arg" label
// from the call args so a sub-agent's tool calls read like an action ("Write
// /path/file.js") instead of a bare verb. Returns undefined for unknown tools
// or when the primary arg is absent, so callers fall back to the raw name.
const SDK_TOOL_TITLE_SPECS: Record<
  string,
  { verb: string; argKeys: string[] }
> = {
  Write: { verb: 'Write', argKeys: ['file_path', 'path'] },
  Read: { verb: 'Read', argKeys: ['file_path', 'path'] },
  Edit: { verb: 'Edit', argKeys: ['file_path', 'path'] },
  MultiEdit: { verb: 'Edit', argKeys: ['file_path', 'path'] },
  NotebookEdit: { verb: 'Edit', argKeys: ['notebook_path', 'file_path'] },
  Bash: { verb: 'Run', argKeys: ['command', 'cmd'] },
  Glob: { verb: 'Find', argKeys: ['pattern'] },
  Grep: { verb: 'Search', argKeys: ['pattern'] },
  WebFetch: { verb: 'Fetch', argKeys: ['url'] },
  WebSearch: { verb: 'Search', argKeys: ['query'] },
};

const SDK_TOOL_TITLE_MAX_LEN = 120;

export const deriveSdkToolTitle = (
  name?: string,
  args?: string | Record<string, unknown>,
): string | undefined => {
  if (!name) {
    return undefined;
  }
  if (name === 'TodoWrite') {
    return 'Update to-dos';
  }
  const spec = SDK_TOOL_TITLE_SPECS[name];
  if (!spec) {
    return undefined;
  }
  const obj = argsToObject(args);
  const detail = spec.argKeys
    .map((key) => obj?.[key])
    .find(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    )
    ?.trim();
  if (!detail) {
    return undefined;
  }
  const label = `${spec.verb} ${detail}`;
  return label.length > SDK_TOOL_TITLE_MAX_LEN
    ? `${label.slice(0, SDK_TOOL_TITLE_MAX_LEN - 1)}…`
    : label;
};

// ────────────────────────────────────────────
// Working-block action summary (Claude-Code style)
// ────────────────────────────────────────────

/** Minimal shape needed to summarize a working block's actions. */
export interface WorkSummaryItem {
  type: 'reasoning' | 'tool' | 'chat' | 'system' | 'subagent' | 'communication';
  name?: string;
  toolKind?: 'generic' | 'shell';
}

const pluralizeCount = (n: number, singular: string, plural?: string): string =>
  `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;

interface ToolActionCategory {
  key: string;
  label: (count: number) => string;
}

/** Maps a tool name to a human-readable action category. Returns a stable
 *  `key` (used to group + count repeated calls) and a `label` builder that
 *  renders the final phrase once the count is known. */
const categorizeToolAction = (
  name: string,
  toolKind?: 'generic' | 'shell',
): ToolActionCategory => {
  const n = name.toLowerCase();

  const mcp = /^mcp__(.+?)__/.exec(n);
  if (mcp) {
    const server = mcp[1];
    const pretty = `${server.charAt(0).toUpperCase()}${server.slice(1)}`;
    return {
      key: `mcp:${server}`,
      label: (c) => `Called ${pretty} ${pluralizeCount(c, 'time')}`,
    };
  }
  if (
    toolKind === 'shell' ||
    /(^|_)(bash|shell|terminal)(_|$)|(^|_)run(_|$)|exec/.test(n)
  ) {
    return {
      key: 'shell',
      label: (c) => `Ran ${pluralizeCount(c, 'command')}`,
    };
  }
  if (/(^|_)(write|create)(_|$)|save_?file/.test(n)) {
    return { key: 'write', label: (c) => `Wrote ${pluralizeCount(c, 'file')}` };
  }
  if (/edit|str_replace|apply_patch|(^|_)(update|replace)(_|$)/.test(n)) {
    return { key: 'edit', label: (c) => `Edited ${pluralizeCount(c, 'file')}` };
  }
  if (/(^|_)(read|cat|view|open)(_|$)/.test(n)) {
    return { key: 'read', label: (c) => `Read ${pluralizeCount(c, 'file')}` };
  }
  if (/(^|_)(ls|list|glob|find)(_|$)|list_?dir/.test(n)) {
    return {
      key: 'list',
      label: (c) => (c === 1 ? 'Listed files' : `Listed files ${c} times`),
    };
  }
  if (/web_?search|web_?fetch|browse|fetch_?url/.test(n)) {
    return {
      key: 'web',
      label: (c) => `Searched the web ${pluralizeCount(c, 'time')}`,
    };
  }
  if (/knowledge/.test(n)) {
    return {
      key: 'knowledge',
      label: (c) => `Searched knowledge ${pluralizeCount(c, 'time')}`,
    };
  }
  if (/grep|codebase_?search|search_?code|code_?search/.test(n)) {
    return {
      key: 'code',
      label: (c) => `Searched the codebase ${pluralizeCount(c, 'time')}`,
    };
  }
  if (/github|^gh_|pull_request|(^|_)issue/.test(n)) {
    return {
      key: 'github',
      label: (c) => `Used GitHub ${pluralizeCount(c, 'time')}`,
    };
  }
  const pretty = name.replace(/_/g, ' ');
  return {
    key: `tool:${n}`,
    label: (c) => `Used ${pretty} ${pluralizeCount(c, 'time')}`,
  };
};

/** Builds a concise, Claude-Code-style summary of the actions in a working
 *  block, e.g. "Wrote 2 files · Called Linear 3 times". Categories appear in
 *  first-seen order. A reasoning-only block summarizes as a thinking line; an
 *  empty or still-running block falls back to a neutral working label. */
export const summarizeWorkItems = (
  items: WorkSummaryItem[],
  opts?: { isRunning?: boolean },
): string => {
  const isRunning = opts?.isRunning ?? false;
  const order: string[] = [];
  const groups = new Map<
    string,
    { count: number; label: (c: number) => string }
  >();

  for (const it of items) {
    if (it.type !== 'tool' || !it.name) {
      continue;
    }
    const cat = categorizeToolAction(it.name, it.toolKind);
    const existing = groups.get(cat.key);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(cat.key, { count: 1, label: cat.label });
      order.push(cat.key);
    }
  }

  if (order.length === 0) {
    if (isRunning) {
      return 'Working…';
    }
    return items.some((it) => it.type === 'reasoning')
      ? 'Thought for a moment'
      : 'Working…';
  }

  return order
    .map((key) => {
      const g = groups.get(key);
      return g ? g.label(g.count) : '';
    })
    .filter(Boolean)
    .join(' · ');
};
