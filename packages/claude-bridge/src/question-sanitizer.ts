import type { BridgeQuestion } from './protocol.types';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Content-block-level trust guard for question payloads, shared by BOTH
 * protocol ends (the bridge sanitizes intercepted AskUserQuestion input, the
 * host sanitizes inbound `question_request` frames): keep only structurally
 * valid entries and fields, drop garbage elements rather than the whole set.
 * One implementation — the two ends must never drift on what "valid" means.
 */
export function sanitizeBridgeQuestions(value: unknown): BridgeQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isPlainRecord).map((entry) => ({
    ...(typeof entry.question === 'string' && { question: entry.question }),
    ...(typeof entry.header === 'string' && { header: entry.header }),
    ...(typeof entry.multiSelect === 'boolean' && {
      multiSelect: entry.multiSelect,
    }),
    ...(Array.isArray(entry.options) && {
      options: entry.options.filter(isPlainRecord).map((option) => ({
        ...(typeof option.label === 'string' && { label: option.label }),
        ...(typeof option.description === 'string' && {
          description: option.description,
        }),
      })),
    }),
  }));
}
