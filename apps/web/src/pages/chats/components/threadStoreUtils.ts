export const formatTimestamp = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
};

export const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

// Append-mode keys are auto-generated server-side as
// `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`. Detecting this
// shape lets us render them as a friendly timestamp instead of a raw blob.
const APPEND_KEY_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-[a-f0-9]{8}$/i;

export const parseAppendKey = (
  key: string,
): { date: Date; suffix: string } | null => {
  const m = APPEND_KEY_RE.exec(key);
  if (!m) {
    return null;
  }
  const date = new Date(m[1]!);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const suffix = key.slice(m[1]!.length + 1);
  return { date, suffix };
};

export const MODE_EXPLANATION = {
  append:
    'Immutable append-only log. Each write adds a new entry with an auto-generated timestamped key. Entries cannot be edited or deleted.',
  kv: 'Overwritable key-value state. Writes upsert under an agent-chosen key, so the latest value replaces any previous one.',
} as const;
