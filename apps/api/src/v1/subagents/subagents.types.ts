import type { LLMRequestContext } from '../agents/agents.types';
import { LlmModelsService } from '../litellm/services/llm-models.service';

/**
 * Logical tool set identifiers available to subagent definitions.
 *
 * Read-only behavior for subagent tools is expressed solely via:
 *   1. A distinct `SubagentToolId.*ReadOnly` enum value, AND
 *   2. The tool builder passing `readOnly: true` so the resulting tool
 *      rejects mutating operations structurally.
 * Do NOT add a separate `readOnly` boolean to tool definition objects —
 * the enum value IS the source of truth.
 *
 * NOTE: ShellReadOnly currently relies on system-prompt enforcement only.
 * Structural enforcement (command-level rejection) is tracked as TODO(M12).
 */
export enum SubagentToolId {
  /** Full shell access. */
  Shell = 'shell',
  /** Shell with read-only access. Currently enforced via system prompt; structural enforcement is TODO(M12). */
  ShellReadOnly = 'shell:read-only',
  /** File tools without edit/write/delete. */
  FilesReadOnly = 'files:read-only',
  /** File tools with all actions. */
  FilesFull = 'files:full',
  /** Full thread-store access (put, append, get, list, delete). */
  ThreadStore = 'thread-store:full',
  /** Thread-store read-only (get, list). */
  ThreadStoreReadOnly = 'thread-store:read-only',
}

/** Context passed to the model resolver callback at runtime. */
export interface SubagentModelContext {
  /** The model name used by the parent agent. */
  parentModel: string;
  /** Service for resolving model names with user and project override logic. */
  llmModelsService: LlmModelsService;
  /** Pre-resolved model override context for the graph owner. */
  modelOverrideContext?: LLMRequestContext;
}

/** Context passed to the systemPrompt builder at runtime. */
export interface SubagentPromptContext {
  /** Absolute path to the currently cloned git repository, if discovered. */
  gitRepoPath?: string;
  /** Additional resource/environment information from the parent agent. */
  resourcesInformation?: string;
}

export interface SubagentDefinition {
  /** Unique identifier for this subagent (e.g. 'explorer', 'simple'). */
  id: string;
  /** Human-readable description shown to the parent LLM when listing agents. */
  description: string;
  /** Builds the system prompt at runtime, receiving workspace context (git repo path, resources info). */
  systemPrompt: (ctx: SubagentPromptContext) => string;
  /** Logical tool IDs this subagent has access to. */
  toolIds: SubagentToolId[];
  /** Resolves the model name at runtime. Receives parent agent model and LlmModelsService. */
  model: (ctx: SubagentModelContext) => string | Promise<string>;
  /** Maximum LLM iterations before the subagent is force-stopped. */
  maxIterations: number;
  /** Max context window tokens. Omit for no limit. */
  maxContextTokens?: number;
}
