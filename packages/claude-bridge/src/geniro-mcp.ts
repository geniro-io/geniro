/**
 * In-bridge proxy surface for forwarded Geniro tools and AskUserQuestion
 * routing. Both run sandbox-side but delegate to the host over the stdio
 * protocol: a tool invocation (or intercepted question) emits an
 * id-correlated request frame and blocks until the matching response command
 * arrives on stdin. The host owns dispatch policy, timeouts, and answers —
 * the bridge only correlates frames.
 */
import { randomUUID } from 'node:crypto';

import {
  type CanUseTool,
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
  tool,
} from '@anthropic-ai/claude-agent-sdk';

import { jsonSchemaToZodShape } from './json-schema-to-zod';
import {
  type BridgeEvent,
  type BridgeToolDefinition,
  GENIRO_MCP_SERVER_KEY,
} from './protocol.types';
import { sanitizeBridgeQuestions } from './question-sanitizer';

/** Resolution of a `tool_call_request`: exactly one of `result`/`error`. */
export type ToolCallResolution = { result?: string; error?: string };

/**
 * Resolution of a `question_request`. `answers` aligns BY INDEX with the
 * request's questions — invalid entries become `undefined` holes (never
 * compacted away, which would shift later answers onto the wrong question).
 */
export type QuestionResolution = {
  answers?: (string | undefined)[];
  deny?: boolean;
};

/**
 * The AskUserQuestion built-in routes through `canUseTool` even under
 * `bypassPermissions` (verified empirically): the callback is the SDK's
 * answer-collection mechanism, not a permission check.
 */
const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/**
 * Pending id-correlated host requests. Handlers block on `resolution` until
 * the host responds or the session ends (`failAll`), which fails every
 * outstanding promise so SDK handlers can return instead of leaking.
 */
export class PendingHostRequests<T> {
  private seq = 0;
  private readonly pending = new Map<string, (value: T | Error) => void>();

  constructor(private readonly prefix: string) {}

  create(): { id: string; resolution: Promise<T> } {
    // The random suffix denies an in-sandbox writer the ability to guess a
    // pending id and cross-resolve another tool's call with forged output.
    const id = `${this.prefix}-${++this.seq}-${randomUUID()}`;
    const resolution = new Promise<T>((resolve, reject) => {
      this.pending.set(id, (value) => {
        if (value instanceof Error) {
          reject(value);
        } else {
          resolve(value);
        }
      });
    });
    return { id, resolution };
  }

  resolve(id: string, value: T): boolean {
    const settle = this.pending.get(id);
    if (!settle) {
      return false;
    }
    this.pending.delete(id);
    settle(value);
    return true;
  }

  failAll(reason: string): void {
    const settlers = [...this.pending.values()];
    this.pending.clear();
    for (const settle of settlers) {
      settle(new Error(reason));
    }
  }
}

/**
 * Build the SDK tool definitions whose handlers proxy invocations to the host
 * and map the resolution to an MCP tool result (`isError` on failure) so the
 * model sees tool errors as content rather than the session crashing.
 * Exported separately from the server wrapper so the handlers are directly
 * exercisable in tests.
 */
export function buildGeniroSdkTools(
  definitions: BridgeToolDefinition[],
  emit: (event: BridgeEvent) => void,
  toolRequests: PendingHostRequests<ToolCallResolution>,
): SdkMcpToolDefinition[] {
  return definitions.map((definition) =>
    tool(
      definition.name,
      definition.description,
      jsonSchemaToZodShape(definition.inputSchema),
      async (args) => {
        const { id, resolution } = toolRequests.create();
        emit({
          type: 'tool_call_request',
          id,
          toolName: definition.name,
          args,
        });
        let resolved: ToolCallResolution;
        try {
          resolved = await resolution;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Tool call failed: ${message}`,
              },
            ],
            isError: true,
          };
        }
        if (resolved.error !== undefined) {
          return {
            content: [{ type: 'text' as const, text: resolved.error }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: resolved.result ?? '' }],
        };
      },
    ),
  );
}

/**
 * In-process MCP server exposing forwarded Geniro tools to the SDK session as
 * `mcp__geniro__<name>`.
 */
export function buildGeniroMcpServer(
  definitions: BridgeToolDefinition[],
  emit: (event: BridgeEvent) => void,
  toolRequests: PendingHostRequests<ToolCallResolution>,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: GENIRO_MCP_SERVER_KEY,
    tools: buildGeniroSdkTools(definitions, emit, toolRequests),
  });
}

/**
 * Permission hook intercepting AskUserQuestion: forwards the questions to the
 * host and answers via `updatedInput.answers` (question text → answer), the
 * SDK's documented answer-collection contract. A deny (host refused, timed
 * out host-side, or the session ended) resolves the tool call gracefully so
 * the model continues without an answer. All other tools pass through.
 */
export function buildCanUseTool(
  emit: (event: BridgeEvent) => void,
  questionRequests: PendingHostRequests<QuestionResolution>,
): CanUseTool {
  return async (toolName, input) => {
    if (toolName !== ASK_USER_QUESTION_TOOL) {
      return { behavior: 'allow', updatedInput: input };
    }
    const questions = sanitizeBridgeQuestions(input.questions);
    const { id, resolution } = questionRequests.create();
    emit({ type: 'question_request', id, questions });
    let resolved: QuestionResolution;
    try {
      resolved = await resolution;
    } catch {
      return {
        behavior: 'deny',
        message:
          'The question could not be delivered. Continue with your best judgment.',
      };
    }
    if (resolved.deny || !resolved.answers?.length) {
      return {
        behavior: 'deny',
        message:
          'The question was not answered. Continue with your best judgment.',
      };
    }
    const answers: Record<string, string> = {};
    questions.forEach((question, index) => {
      const answer = resolved.answers?.[index];
      if (typeof question.question === 'string' && typeof answer === 'string') {
        answers[question.question] = answer;
      }
    });
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  };
}
