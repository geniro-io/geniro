export const CLAUDE_INSTALL_DIR = '/opt/geniro-claude';
export const CLAUDE_PLUGINS_DIR = `${CLAUDE_INSTALL_DIR}/plugins`;

/**
 * Per-thread Claude session metadata persisted in `Thread.metadata` for
 * cross-turn continuity (resume when the container is alive, replay when not).
 * Sessions are keyed BY NODE ID: a root thread can host several Claude agents
 * (kind-agnostic communication tool), and a single thread-scoped session id
 * would let agent X resume agent Y's transcript.
 * Virtual keys are deliberately NOT persisted here — they live only in process
 * memory for the duration of a run and are revoked in its `finally`.
 */
export type ClaudeThreadMetadata = {
  claudeSessions?: Record<string, string>;
};
