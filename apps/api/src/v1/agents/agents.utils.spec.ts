import {
  AIMessage,
  ChatMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import {
  buildReasoningMessage,
  convertChunkToMessage,
  extractExploredFilesFromMessages,
  extractTextFromResponseContent,
  filterMessagesForLlm,
  formatToolOutputForLlm,
  isRunnableAgent,
  markMessageHideForLlm,
  prepareMessagesForLlm,
  stripProxyPrefix,
  updateMessagesListWithMetadata,
  updateMessageWithMetadata,
} from './agents.utils';

describe('agents.utils', () => {
  describe('markMessageHideForLlm', () => {
    it('should mark a message with hideForLlm flag', () => {
      const message = new SystemMessage('Test message');
      const marked = markMessageHideForLlm(message);

      expect(marked.additional_kwargs?.__hideForLlm).toBe(true);
      expect(marked.content).toBe('Test message');
    });

    it('should preserve existing additional_kwargs', () => {
      const message = new SystemMessage('Test message');
      message.additional_kwargs = { custom: 'value' };
      const marked = markMessageHideForLlm(message);

      expect(marked.additional_kwargs?.__hideForLlm).toBe(true);
      expect(marked.additional_kwargs?.custom).toBe('value');
    });

    it('should not mutate the original message', () => {
      const message = new SystemMessage('Test message');
      const marked = markMessageHideForLlm(message);

      expect(message.additional_kwargs?.__hideForLlm).toBeUndefined();
      expect(marked.additional_kwargs?.__hideForLlm).toBe(true);
    });
  });

  describe('filterMessagesForLlm', () => {
    it('should filter out messages with hideForLlm flag', () => {
      const messages = [
        new HumanMessage('User message'),
        markMessageHideForLlm(new SystemMessage('Summary message')),
        new AIMessage('Assistant message'),
      ];

      const filtered = filterMessagesForLlm(messages);

      expect(filtered).toHaveLength(2);
      expect(filtered[0]?.content).toBe('User message');
      expect(filtered[1]?.content).toBe('Assistant message');
    });

    it('should keep all messages if none have hideForLlm flag', () => {
      const messages = [
        new HumanMessage('User message'),
        new SystemMessage('System message'),
        new AIMessage('Assistant message'),
      ];

      const filtered = filterMessagesForLlm(messages);

      expect(filtered).toHaveLength(3);
    });

    it('should return empty array if all messages are hidden', () => {
      const messages = [
        markMessageHideForLlm(new HumanMessage('Hidden user message')),
        markMessageHideForLlm(new SystemMessage('Hidden system message')),
      ];

      const filtered = filterMessagesForLlm(messages);

      expect(filtered).toHaveLength(0);
    });

    it('should always filter out reasoning role messages (defense-in-depth)', () => {
      const messages = [
        new HumanMessage('User message'),
        new ChatMessage('Reasoning message', 'reasoning'),
        new AIMessage('Assistant message'),
      ];

      const filtered = filterMessagesForLlm(messages);

      expect(filtered).toHaveLength(2);
      expect(filtered[0]?.content).toBe('User message');
      expect(filtered[1]?.content).toBe('Assistant message');
    });

    it('should return empty array for empty input', () => {
      const filtered = filterMessagesForLlm([]);
      expect(filtered).toHaveLength(0);
    });

    it('should remove AI tool call messages that have missing tool results', () => {
      const toolCallId = 'call-1';
      const msgs = [
        new AIMessage({
          content: 'calling tool',
          tool_calls: [
            { id: toolCallId, name: 'tool', args: {}, type: 'tool_call' },
          ],
        }),
      ];

      const cleaned = filterMessagesForLlm(msgs);
      expect(cleaned).toHaveLength(0);
    });

    it('should keep AI tool call messages when matching tool results exist', () => {
      const toolCallId = 'call-1';
      const msgs = [
        new AIMessage({
          content: 'calling tool',
          tool_calls: [
            { id: toolCallId, name: 'tool', args: {}, type: 'tool_call' },
          ],
        }),
        // ToolMessage in LangChain carries tool_call_id
        new ToolMessage({
          tool_call_id: toolCallId,
          name: 'tool',
          content: 'ok',
        }),
      ];

      const cleaned = filterMessagesForLlm(msgs);
      expect(cleaned).toHaveLength(2);
    });

    it('should remove ToolMessages that do not have a matching tool call', () => {
      const msgs = [
        new HumanMessage('hi'),
        new ToolMessage({
          tool_call_id: 'call-orphan',
          name: 'tool',
          content: 'orphan result',
        }),
      ];

      const cleaned = filterMessagesForLlm(msgs);
      expect(cleaned).toHaveLength(1);
      expect(cleaned[0]).toBeInstanceOf(HumanMessage);
    });

    it('should consider tool calls in additional_kwargs.tool_calls for cleaning', () => {
      const toolCallId = 'call-kw';
      const aiWithKwToolCall = new AIMessage({
        content: '',
        additional_kwargs: {
          tool_calls: [
            {
              id: toolCallId,
              type: 'function',
              function: { name: 'tool', arguments: '{}' },
            },
          ],
        },
      });

      const cleaned1 = filterMessagesForLlm([aiWithKwToolCall]);
      expect(cleaned1).toHaveLength(0);

      const cleaned2 = filterMessagesForLlm([
        aiWithKwToolCall,
        new ToolMessage({
          tool_call_id: toolCallId,
          name: 'tool',
          content: 'ok',
        }),
      ]);
      expect(cleaned2).toHaveLength(2);
    });

    it('should keep non-tool-calling AI messages unchanged', () => {
      const msgs = [new AIMessage('hello'), new HumanMessage('hi')];
      const cleaned = filterMessagesForLlm(msgs);
      expect(cleaned).toHaveLength(2);
    });

    it('should keep AI + ToolMessage pair when tool call id is undefined (generated missing_id)', () => {
      // This reproduces the subagent infinite loop: the LLM returns tool_calls with
      // undefined ids, ToolExecutorNode assigns missing_id_xxx, but filterMessagesForLlm
      // must still keep both the AI message and the tool result.
      const generatedId = 'missing_id_abc123';
      const aiMsg = new AIMessage({
        content: '',
        tool_calls: [
          {
            name: 'files_read',
            args: { filesToRead: [{ filePath: '/hello.js' }] },
            type: 'tool_call',
          } as any,
        ],
      });
      const toolMsg = new ToolMessage({
        tool_call_id: generatedId,
        name: 'files_read',
        content: 'file content here',
      });

      const cleaned = filterMessagesForLlm([
        new HumanMessage('Read /hello.js'),
        aiMsg,
        toolMsg,
      ]);

      // Both AI message and tool result must survive so the LLM sees the full roundtrip
      expect(cleaned).toHaveLength(3);
      expect(cleaned[1]).toBeInstanceOf(AIMessage);
      expect(cleaned[2]).toBeInstanceOf(ToolMessage);
    });

    it('should keep Gemini-style tool call IDs with special characters', () => {
      const geminiId =
        'call_cf0b58b0639048e7ae7176f19fd6__thought__EjQKMgG+Pvb7DF';
      const msgs = [
        new HumanMessage('Read file'),
        new AIMessage({
          content: '',
          tool_calls: [
            {
              id: geminiId,
              name: 'files_read',
              args: {},
              type: 'tool_call',
            },
          ],
        }),
        new ToolMessage({
          tool_call_id: geminiId,
          name: 'files_read',
          content: 'ok',
        }),
      ];

      const cleaned = filterMessagesForLlm(msgs);
      expect(cleaned).toHaveLength(3);
    });
  });

  describe('prepareMessagesForLlm', () => {
    it('should filter hideForLlm messages and then clean dangling tool calls', () => {
      const toolCallId = 'call-1';
      const msgs = [
        markMessageHideForLlm(new SystemMessage('hidden')),
        new AIMessage({
          content: 'calling tool',
          tool_calls: [
            { id: toolCallId, name: 'tool', args: {}, type: 'tool_call' },
          ],
        }),
      ];

      const prepared = prepareMessagesForLlm(msgs);
      expect(prepared).toHaveLength(0);
    });

    it('should strip ids + metadata and flatten structured AI content', () => {
      const ai = new AIMessage({
        content: [
          { type: 'text', text: 'Hello' },
          // This simulates responses-style content blocks where a provider may include non-text blocks.
          // We should not send structured blocks back to the model.
          { type: 'reasoning', reasoning: 'secret', summary: 'n/a' } as any,
          { type: 'text', text: 'World' },
        ] as any,
      });
      (ai as any).id = 'rs_123';
      (ai as any).response_metadata = { foo: 'bar' };
      (ai as any).usage_metadata = { input_tokens: 1 };
      ai.additional_kwargs = { __runId: 'run-1', __hideForLlm: false };

      const prepared = prepareMessagesForLlm([ai]);

      expect(prepared).toHaveLength(1);
      const out = prepared[0] as AIMessage;
      expect((out as any).id).toBeUndefined();
      expect((out as any).response_metadata).toEqual({ foo: 'bar' });
      expect((out as any).usage_metadata).toEqual({ input_tokens: 1 });
      expect(out.additional_kwargs).toEqual({
        __runId: 'run-1',
        __hideForLlm: false,
      });
      expect(out.content).toBe('Hello\nWorld');
    });

    it('should preserve ToolMessage content and tool_call_id for LLM', () => {
      const toolCallId = 'call-123';
      const toolContent = 'Tool execution result';
      const msgs = [
        new HumanMessage('Run tool'),
        new AIMessage({
          content: 'calling tool',
          tool_calls: [
            {
              id: toolCallId,
              name: 'test_tool',
              args: { param: 'value' },
              type: 'tool_call',
            },
          ],
        }),
        new ToolMessage({
          tool_call_id: toolCallId,
          name: 'test_tool',
          content: toolContent,
          additional_kwargs: {
            __model: 'gpt-4',
            __tokenUsage: { totalTokens: 10 },
          },
        }),
      ];

      const prepared = prepareMessagesForLlm(msgs);

      expect(prepared).toHaveLength(3);
      const toolMsg = prepared[2] as ToolMessage;
      expect(toolMsg).toBeInstanceOf(ToolMessage);
      expect(toolMsg.tool_call_id).toBe(toolCallId);
      expect(toolMsg.name).toBe('test_tool');
      expect(toolMsg.content).toBe(toolContent);
      expect(toolMsg.additional_kwargs).toEqual({
        __model: 'gpt-4',
        __tokenUsage: { totalTokens: 10 },
      });
    });
  });

  describe('updateMessageWithMetadata', () => {
    it('should add run_id metadata to a message', () => {
      const message = new HumanMessage('Test');
      const config = {
        configurable: {
          run_id: 'test-run-123',
        },
      };

      const updated = updateMessageWithMetadata(message, config as any);

      expect(updated.additional_kwargs?.__runId).toBe('test-run-123');
    });

    it('should not overwrite existing run_id', () => {
      const message = new HumanMessage('Test');
      message.additional_kwargs = { __runId: 'existing-run' };

      const config = {
        configurable: {
          run_id: 'new-run',
        },
      };

      const updated = updateMessageWithMetadata(message, config as any);

      expect(updated.additional_kwargs?.__runId).toBe('existing-run');
    });

    it('should preserve an existing specific __toolCallId on the message and NOT overwrite with a broader id from configurable', () => {
      // Reproduces the subagent->communication nesting bug: SubAgent tags reasoning
      // with the specific subagents_run_task call id, but ToolExecutorNode calls
      // updateMessagesListWithMetadata with the outer caller's configurable (whose
      // __toolCallId is the broader communication_exec id). The inner id must survive.
      const message = new AIMessage('reasoning content');
      message.additional_kwargs = { __toolCallId: 'specific-inner' };

      const config = {
        configurable: {
          run_id: 'run-1',
          __toolCallId: 'broader-outer',
        },
      };

      const updated = updateMessageWithMetadata(message, config as any);

      expect(updated.additional_kwargs?.__toolCallId).toBe('specific-inner');
    });

    it('should apply __toolCallId from configurable when the message has none', () => {
      const message = new AIMessage('some content');

      const config = {
        configurable: {
          run_id: 'run-2',
          __toolCallId: 'from-configurable',
        },
      };

      const updated = updateMessageWithMetadata(message, config as any);

      expect(updated.additional_kwargs?.__toolCallId).toBe('from-configurable');
    });
  });

  describe('extractTextFromResponseContent', () => {
    it('should flatten structured content arrays', () => {
      const result = extractTextFromResponseContent([
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'World' },
      ]);
      expect(result).toBe('Hello\nWorld');
    });

    it('should flatten stringified structured content', () => {
      const payload = JSON.stringify([{ type: 'text', text: 'Structured' }]);
      const result = extractTextFromResponseContent(payload);
      expect(result).toBe('Structured');
    });

    it('should trim plain string content', () => {
      const result = extractTextFromResponseContent('  plain text ');
      expect(result).toBe('plain text');
    });

    it('should flatten OpenAI Responses API output_text content blocks', () => {
      const result = extractTextFromResponseContent([
        { type: 'output_text', text: 'Findings from analysis' },
      ]);
      expect(result).toBe('Findings from analysis');
    });

    it('should flatten mixed text and output_text content blocks', () => {
      const result = extractTextFromResponseContent([
        { type: 'text', text: 'Part one' },
        { type: 'output_text', text: 'Part two' },
      ]);
      expect(result).toBe('Part one\nPart two');
    });

    it('should return undefined when parsing fails', () => {
      expect(extractTextFromResponseContent({})).toBeUndefined();
    });
  });

  describe('updateMessagesListWithMetadata', () => {
    it('should add run_id metadata to all messages', () => {
      const messages = [
        new HumanMessage('Message 1'),
        new SystemMessage('Message 2'),
        new AIMessage('Message 3'),
      ];

      const config = {
        configurable: {
          run_id: 'test-run-123',
        },
      };

      const updated = updateMessagesListWithMetadata(messages, config as any);

      expect(updated).toHaveLength(3);
      updated.forEach((msg) => {
        expect(msg.additional_kwargs?.__runId).toBe('test-run-123');
      });
    });
  });

  describe('integration: hideForLlm with other metadata', () => {
    it('should preserve hideForLlm flag when updating metadata', () => {
      const message = markMessageHideForLlm(new SystemMessage('Test'));
      const config = {
        configurable: {
          run_id: 'test-run-123',
        },
      };

      const updated = updateMessageWithMetadata(message, config as any);

      expect(updated.additional_kwargs?.__hideForLlm).toBe(true);
      expect(updated.additional_kwargs?.__runId).toBe('test-run-123');
    });

    it('should filter hideForLlm messages even after metadata update', () => {
      const messages = [
        new HumanMessage('User message'),
        markMessageHideForLlm(new SystemMessage('Summary message')),
      ];

      const config = {
        configurable: {
          run_id: 'test-run-123',
        },
      };

      const updated = updateMessagesListWithMetadata(messages, config as any);
      const filtered = filterMessagesForLlm(updated);

      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.content).toBe('User message');
    });
  });

  describe('buildReasoningMessage', () => {
    it('should prefix id with reasoning namespace when parent id provided', () => {
      const msg = buildReasoningMessage('reasoning text', 'parent-123');

      expect(msg.role).toBe('reasoning');
      expect(msg.id).toBe('reasoning:parent-123');
      expect(msg.additional_kwargs?.__hideForLlm).toBe(true);
      expect(msg.additional_kwargs?.__hideForSummary).toBe(true);
      expect(msg.additional_kwargs?.__reasoningId).toBe('reasoning:parent-123');
    });

    it('should set hideForLlm and hideForSummary even without parent id', () => {
      const msg = buildReasoningMessage('reasoning text');

      expect(msg.role).toBe('reasoning');
      expect(msg.additional_kwargs?.__hideForLlm).toBe(true);
      expect(msg.additional_kwargs?.__hideForSummary).toBe(true);
    });
  });

  describe('extractExploredFilesFromMessages', () => {
    it('should return empty array when no file-related messages exist', () => {
      const messages = [new HumanMessage('Hello'), new AIMessage('Hi there')];
      expect(extractExploredFilesFromMessages(messages)).toEqual([]);
    });

    it('should extract file paths from files_read tool calls', () => {
      const messages = [
        new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              name: 'files_read',
              args: {
                filesToRead: [
                  { filePath: '/repo/src/b.ts' },
                  { filePath: '/repo/src/a.ts' },
                ],
              },
              type: 'tool_call' as const,
            },
          ],
        }),
        new ToolMessage({
          tool_call_id: 'call-1',
          name: 'files_read',
          content: 'file contents',
        }),
      ];
      const result = extractExploredFilesFromMessages(messages);
      expect(result).toEqual(['/repo/src/a.ts', '/repo/src/b.ts']);
    });

    it('should extract file paths from codebase_search results', () => {
      const messages = [
        new ToolMessage({
          tool_call_id: 'call-2',
          name: 'codebase_search',
          content: JSON.stringify({
            results: [
              { path: '/repo/src/foo.ts', snippet: '...' },
              { path: '/repo/src/bar.ts', snippet: '...' },
            ],
          }),
        }),
      ];
      const result = extractExploredFilesFromMessages(messages);
      expect(result).toEqual(['/repo/src/bar.ts', '/repo/src/foo.ts']);
    });

    it('should extract file paths from files_search_text results', () => {
      const messages = [
        new ToolMessage({
          tool_call_id: 'call-3',
          name: 'files_search_text',
          content: JSON.stringify({
            matches: [{ filePath: '/repo/src/utils.ts', line: 10 }],
          }),
        }),
      ];
      const result = extractExploredFilesFromMessages(messages);
      expect(result).toEqual(['/repo/src/utils.ts']);
    });

    it('should deduplicate file paths across multiple messages', () => {
      const messages = [
        new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              name: 'files_read',
              args: { filesToRead: [{ filePath: '/repo/src/a.ts' }] },
              type: 'tool_call' as const,
            },
          ],
        }),
        new ToolMessage({
          tool_call_id: 'call-2',
          name: 'codebase_search',
          content: JSON.stringify({
            results: [{ path: '/repo/src/a.ts' }, { path: '/repo/src/b.ts' }],
          }),
        }),
      ];
      const result = extractExploredFilesFromMessages(messages);
      expect(result).toEqual(['/repo/src/a.ts', '/repo/src/b.ts']);
    });

    it('should ignore non-file tool calls', () => {
      const messages = [
        new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              name: 'shell',
              args: { command: 'ls' },
              type: 'tool_call' as const,
            },
          ],
        }),
        new ToolMessage({
          tool_call_id: 'call-1',
          name: 'shell',
          content: 'file1.ts\nfile2.ts',
        }),
      ];
      expect(extractExploredFilesFromMessages(messages)).toEqual([]);
    });

    it('should handle malformed JSON in tool results gracefully', () => {
      const messages = [
        new ToolMessage({
          tool_call_id: 'call-1',
          name: 'codebase_search',
          content: 'not valid json',
        }),
      ];
      expect(extractExploredFilesFromMessages(messages)).toEqual([]);
    });
  });

  describe('stripProxyPrefix', () => {
    const tools = new Set([
      'gh_clone',
      'knowledge_search_docs',
      'proxy_handler',
    ]);

    it('strips proxy_ when stripped name is a known tool', () => {
      expect(stripProxyPrefix('proxy_gh_clone', tools)).toBe('gh_clone');
      expect(stripProxyPrefix('proxy_knowledge_search_docs', tools)).toBe(
        'knowledge_search_docs',
      );
    });

    it('does not strip when the prefixed name itself is a known tool', () => {
      expect(stripProxyPrefix('proxy_handler', tools)).toBe('proxy_handler');
    });

    it('does not strip when the stripped name is not a known tool', () => {
      expect(stripProxyPrefix('proxy_unknown', tools)).toBe('proxy_unknown');
    });

    it('returns name unchanged when it does not start with proxy_', () => {
      expect(stripProxyPrefix('gh_clone', tools)).toBe('gh_clone');
      expect(stripProxyPrefix('finish', tools)).toBe('finish');
    });
  });

  describe('convertChunkToMessage', () => {
    it('should extract tool calls from additional_kwargs.tool_calls (OpenAI shape)', () => {
      const chunk = {
        id: 'run-1',
        name: undefined,
        content: '',
        contentBlocks: [],
        response_metadata: {},
        tool_calls: [],
        invalid_tool_calls: [],
        usage_metadata: undefined,
        additional_kwargs: {
          tool_calls: [
            {
              id: 'call_123',
              type: 'function',
              function: {
                name: 'finish',
                arguments: '{"purpose":"x","message":"y","needsMoreInfo":true}',
              },
              index: 0,
            },
          ],
        },
      } as any;

      const msg = convertChunkToMessage(chunk);
      const toolCalls = msg.tool_calls ?? [];
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]?.name).toBe('finish');
      expect(toolCalls[0]?.args).toEqual({
        purpose: 'x',
        message: 'y',
        needsMoreInfo: true,
      });
    });
  });
});

describe('isRunnableAgent', () => {
  const fullSurface = () => ({
    run: () => Promise.resolve(),
    runOrAppend: () => Promise.resolve(),
    stopThread: () => Promise.resolve(true),
    subscribe: () => () => {},
    emit: () => {},
    getGraphNodeMetadata: () => undefined,
  });

  it('accepts an object exposing the full RunnableAgent surface', () => {
    expect(isRunnableAgent(fullSurface())).toBe(true);
  });

  it('rejects an object missing any surface method', () => {
    for (const method of [
      'run',
      'runOrAppend',
      'stopThread',
      'subscribe',
      'emit',
      'getGraphNodeMetadata',
    ]) {
      const candidate = fullSurface() as Record<string, unknown>;
      delete candidate[method];
      expect(isRunnableAgent(candidate)).toBe(false);
    }
  });

  it('rejects null, undefined and primitives', () => {
    expect(isRunnableAgent(null)).toBe(false);
    expect(isRunnableAgent(undefined)).toBe(false);
    expect(isRunnableAgent('agent')).toBe(false);
    expect(isRunnableAgent(42)).toBe(false);
  });
});

describe('formatToolOutputForLlm', () => {
  it('returns a string when a tool produced no output (undefined) — both callers take .length of the result', () => {
    // ToolExecutorNode and ClaudeToolDispatcher immediately read `.length`
    // on the returned value to apply their output caps; the declared `string`
    // return type must hold for every input, including a void tool result.
    const formatted = formatToolOutputForLlm(undefined);
    expect(typeof formatted).toBe('string');
  });

  it('short-circuits the JSON→YAML conversion for a raw string already past 2x the cap', () => {
    // A multi-MB tool output (e.g. files_read of a long-line file) arrives as a
    // JSON string the caller trims anyway; trimmed JSON is exactly as
    // (un)parseable for the model as trimmed YAML, so the expensive parse +
    // re-serialize is skipped rather than burning event-loop time on work the
    // cap discards.
    const maxChars = 1000;
    const huge = `{"data":"${'x'.repeat(3000)}"}`;
    expect(huge.length).toBeGreaterThan(2 * maxChars);

    const formatted = formatToolOutputForLlm(huge, maxChars);

    // Byte-identical to the input — proof the YAML conversion never ran.
    expect(formatted).toBe(huge);
  });

  it('still converts a JSON string inside the 2x band (YAML compaction may fit under the cap)', () => {
    const maxChars = 1000;
    const payload = JSON.stringify({ alpha: 'one', beta: 'two' });
    expect(payload.length).toBeLessThanOrEqual(2 * maxChars);

    const formatted = formatToolOutputForLlm(payload, maxChars);

    expect(formatted).not.toBe(payload);
    expect(formatted).toContain('alpha: one');
    expect(formatted).toContain('beta: two');
  });

  it('always converts a JSON string when no cap is supplied (back-compat)', () => {
    const payload = JSON.stringify({ alpha: 'one' });
    expect(formatToolOutputForLlm(payload)).toBe('alpha: one');
  });

  it('does not short-circuit a non-string object output — the maxChars guard is string-only', () => {
    const maxChars = 10;
    const obj = { items: Array.from({ length: 50 }, (_, i) => `item-${i}`) };

    const formatted = formatToolOutputForLlm(obj, maxChars);

    // An already-parsed object always serializes to YAML (no raw string to fall
    // back to), even past 2x the cap — the caller trims the result.
    expect(formatted).toContain('items:');
    expect(formatted).not.toBe(JSON.stringify(obj));
  });
});
