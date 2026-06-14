/**
 * Sandbox-side bridge entry. Runs inside the runtime container, never on the
 * API host. Speaks the JSON-line protocol from protocol.types.ts: commands in
 * on stdin, events out on stdout (stdout carries protocol frames ONLY — all
 * diagnostics go to stderr).
 *
 * Lifecycle: one process per turn. The host sends `start` (optionally with
 * `resume` for cross-turn continuity), the bridge runs a Claude Agent SDK
 * query and forwards every SDK message verbatim. After the turn's `result`
 * message the input stream closes and the process exits 0. `interrupt`
 * aborts the query; `user_message` injects into the live session over the
 * SDK streaming-input channel.
 */
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import {
  buildCanUseTool,
  buildGeniroMcpServer,
  PendingHostRequests,
  type QuestionResolution,
  type ToolCallResolution,
} from './geniro-mcp';
import { JsonLineParser, serializeFrame } from './json-line-parser';
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCommand,
  type BridgeEvent,
  type BridgeStartOptions,
  type SdkMessage,
} from './protocol.types';

function emit(event: BridgeEvent): void {
  process.stdout.write(serializeFrame(event));
}

function logErr(message: string): void {
  process.stderr.write(`[claude-bridge] ${message}\n`);
}

// Shared invalid-line reporter for every JsonLineParser.push on stdin. `line`
// is a host→sandbox stdin byte sequence and the parser only hard-discards
// lines past its 10M-char cap, so the echo is bounded here to keep a large
// malformed line from flooding stderr (which the host logs).
function logInvalidStdinLine(line: string, error: Error): void {
  logErr(
    `Ignoring invalid stdin line (${error.message}): ${line.slice(0, 200)}`,
  );
}

class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = [];
  private resolveNext: (() => void) | null = null;
  private closed = false;

  push(text: string): boolean {
    if (this.closed) {
      return false;
    }
    this.pending.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.resolveNext?.();
    return true;
  }

  close(): void {
    this.closed = true;
    this.resolveNext?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      while (this.pending.length > 0) {
        yield this.pending.shift()!;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.resolveNext = resolve;
      });
      this.resolveNext = null;
    }
  }
}

async function runSession(
  options: BridgeStartOptions,
  // Frames the start handshake read from the same pipe chunk(s) as `start`
  // but could not consume itself: the commands parsed after `start`, plus the
  // start parser's unconsumed partial line. Replayed here so an injection the
  // host coalesced with `start` is never dropped (bridge.spec.ts coalesced
  // user_message test).
  pendingCommands: BridgeCommand[] = [],
  pendingBuffer = '',
): Promise<void> {
  const abortController = new AbortController();
  const inputQueue = new AsyncMessageQueue();
  inputQueue.push(options.prompt);

  let lastSessionId: string | undefined;
  let aborted = false;

  const toolRequests = new PendingHostRequests<ToolCallResolution>('tool');
  const questionRequests = new PendingHostRequests<QuestionResolution>(
    'question',
  );

  const handleCommand = (command: BridgeCommand): void => {
    if (typeof command !== 'object' || command === null) {
      logErr(`Ignoring non-object stdin frame: ${JSON.stringify(command)}`);
      return;
    }
    if (command.type === 'interrupt' || command.type === 'shutdown') {
      aborted = true;
      inputQueue.close();
      toolRequests.failAll('session aborted');
      questionRequests.failAll('session aborted');
      abortController.abort();
    } else if (command.type === 'user_message') {
      // The turn's `result` closes the input queue (one turn per process), but
      // the SDK session can stay open afterwards. A user_message that lands in
      // that window cannot be delivered into the closed queue — replay-only
      // delivery, per the M2 accepted residue. Surface the drop instead of
      // swallowing it silently so a lost injection is never a phantom.
      const delivered = inputQueue.push(command.text);
      if (!delivered) {
        logErr(
          `Dropped user_message — input queue closed after turn result: ${command.text.slice(
            0,
            200,
          )}`,
        );
      }
    } else if (command.type === 'tool_call_response') {
      if (typeof command.id !== 'string') {
        logErr('Ignoring tool_call_response without a string id');
        return;
      }
      const matched = toolRequests.resolve(command.id, {
        ...(typeof command.result === 'string' && {
          result: command.result,
        }),
        ...(typeof command.error === 'string' && { error: command.error }),
      });
      if (!matched) {
        logErr(`No pending tool call for id ${command.id}`);
      }
    } else if (command.type === 'question_response') {
      if (typeof command.id !== 'string') {
        logErr('Ignoring question_response without a string id');
        return;
      }
      const matched = questionRequests.resolve(command.id, {
        ...(Array.isArray(command.answers) && {
          // map, not filter: answers align with questions BY INDEX, so an
          // invalid entry must stay as an undefined hole — compacting it
          // would shift every later answer onto the wrong question.
          answers: command.answers.map((answer) =>
            typeof answer === 'string' ? answer : undefined,
          ),
        }),
        ...(typeof command.deny === 'boolean' && { deny: command.deny }),
      });
      if (!matched) {
        logErr(`No pending question for id ${command.id}`);
      }
    } else {
      logErr(`Ignoring unexpected command while running: ${command.type}`);
    }
  };

  const stdinParser = new JsonLineParser<BridgeCommand>();
  const onStdin = (chunk: Buffer) => {
    const commands = stdinParser.push(chunk, logInvalidStdinLine);
    for (const command of commands) {
      handleCommand(command);
    }
  };
  process.stdin.on('data', onStdin);

  // Drain the carry-over from the start handshake before the SDK query begins
  // consuming the input queue. Stream order is preserved: the commands that
  // followed `start` in the chunk first, then the partial line seeded into
  // this session's parser so a later chunk completes it.
  for (const command of pendingCommands) {
    handleCommand(command);
  }
  if (pendingBuffer) {
    const carried = stdinParser.push(pendingBuffer, logInvalidStdinLine);
    for (const command of carried) {
      handleCommand(command);
    }
  }

  try {
    const session = query({
      prompt: inputQueue,
      options: {
        model: options.model,
        abortController,
        // M1 does not forward per-token partials (the host mapper drops
        // stream_event frames); skip serializing them over the exec stream.
        // M2 token streaming re-enables this.
        includePartialMessages: false,
        permissionMode: 'bypassPermissions',
        ...(options.maxTurns !== undefined && { maxTurns: options.maxTurns }),
        ...(options.resume !== undefined && { resume: options.resume }),
        ...(options.cwd !== undefined && { cwd: options.cwd }),
        ...(options.settingSources !== undefined && {
          settingSources: options.settingSources,
        }),
        ...(options.pluginPaths?.length && {
          plugins: options.pluginPaths.map((path) => ({
            type: 'local' as const,
            path,
          })),
        }),
        ...(options.systemPrompt !== undefined && {
          systemPrompt: {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: options.systemPrompt,
          },
        }),
        ...(options.tools?.length && {
          mcpServers: {
            geniro: buildGeniroMcpServer(options.tools, emit, toolRequests),
          },
        }),
        canUseTool: buildCanUseTool(emit, questionRequests),
      },
    });

    for await (const message of session) {
      const sdkMessage = message as unknown as SdkMessage;
      if ('session_id' in sdkMessage && sdkMessage.session_id) {
        lastSessionId = sdkMessage.session_id;
      }
      emit({ type: 'sdk_message', message: sdkMessage });

      // One turn per process: the turn's result closes the input stream so
      // the SDK query terminates and the process can exit cleanly.
      if (sdkMessage.type === 'result') {
        inputQueue.close();
      }
    }

    emit(
      aborted
        ? { type: 'aborted', sessionId: lastSessionId }
        : { type: 'done', sessionId: lastSessionId },
    );
  } catch (error) {
    if (aborted) {
      emit({ type: 'aborted', sessionId: lastSessionId });
      return;
    }
    throw error;
  } finally {
    toolRequests.failAll('session ended');
    questionRequests.failAll('session ended');
    process.stdin.off('data', onStdin);
  }
}

async function main(): Promise<void> {
  // If the host tears the exec streams down without a shutdown frame, exit
  // instead of blocking on stdin forever — repeated transport failures must
  // not accumulate zombie node processes in a long-lived container.
  process.stdin.on('end', () => {
    logErr('stdin closed — exiting');
    process.exit(0);
  });

  emit({ type: 'ready', protocolVersion: BRIDGE_PROTOCOL_VERSION });

  const startParser = new JsonLineParser<BridgeCommand>();
  let pendingCommands: BridgeCommand[] = [];
  const start = await new Promise<BridgeStartOptions>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      const commands = startParser.push(chunk, logInvalidStdinLine);
      for (let index = 0; index < commands.length; index += 1) {
        const command = commands[index]!;
        if (typeof command !== 'object' || command === null) {
          logErr(`Ignoring non-object stdin frame: ${JSON.stringify(command)}`);
          continue;
        }
        if (command.type === 'start') {
          process.stdin.off('data', onData);
          // Frames the host coalesced into the same pipe read after `start`
          // (its back-to-back flush of buffered injections) are handed to the
          // running session instead of being discarded with this handler.
          pendingCommands = commands.slice(index + 1);
          resolve(command.options);
          return;
        }
        // interrupt-before-start means the run was stopped while the bridge
        // was still booting — treat it like shutdown rather than ignoring it,
        // so a stopped thread can never launch a billable session.
        if (command.type === 'shutdown' || command.type === 'interrupt') {
          process.stdin.off('data', onData);
          reject(new Error(`${command.type} before start`));
          return;
        }
        logErr(`Ignoring command before start: ${command.type}`);
      }
    };
    process.stdin.on('data', onData);
  });

  // startParser.pending() carries the unconsumed partial line (if the host's
  // chunk ended mid-frame) so the running session can complete it.
  await runSession(start, pendingCommands, startParser.pending());
}

void main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'fatal', error: message });
    logErr(message);
    process.exit(1);
  });
