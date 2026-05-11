import type { MockLlmMatcher, MockLlmRequest } from './mock-llm.types';

/**
 * Thrown by `MockLlmService.match()` when no registered fixture or queued
 * reply matches the incoming request.
 *
 * The `name` property is explicitly set to `'MockLlmNoMatchError'` so that
 * `err.name` checks work across module boundaries even when the class is
 * transpiled or bundled.
 */
export class MockLlmNoMatchError extends Error {
  public readonly request: MockLlmRequest;
  public readonly registeredMatchers: MockLlmMatcher[];

  constructor(opts: {
    request: MockLlmRequest;
    registeredMatchers: MockLlmMatcher[];
  }) {
    const { request, registeredMatchers } = opts;

    const truncate = (s: string | undefined, max: number): string => {
      if (!s) {
        return '(none)';
      }
      return s.length > max ? `${s.slice(0, max)}…` : s;
    };

    const matcherLines =
      registeredMatchers.length > 0
        ? registeredMatchers.map((m) => `    ${JSON.stringify(m)}`).join('\n')
        : '    (none)';

    const message = [
      'MockLlmService: no fixture matched.',
      `  model: ${request.model ?? '(none)'}`,
      `  callIndex: ${request.callIndex}`,
      `  lastUserMessage: ${truncate(request.lastUserMessage, 500)}`,
      `  systemMessage: ${truncate(request.systemMessage, 200)}`,
      `  boundTools: [${(request.boundTools ?? []).join(', ')}]`,
      `  lastToolResult: ${request.lastToolResult?.name ?? 'none'}`,
      `  registered matchers (${registeredMatchers.length}):`,
      matcherLines,
    ].join('\n');

    super(message);
    this.name = 'MockLlmNoMatchError';
    this.request = request;
    this.registeredMatchers = registeredMatchers;
  }
}
