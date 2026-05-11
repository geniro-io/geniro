/* eslint-disable @typescript-eslint/naming-convention -- internal counter needs leading underscore */
import { Injectable } from '@nestjs/common';

import {
  MockMcpCallToolFixture,
  MockMcpCallToolMatcher,
  MockMcpCallToolReply,
  MockMcpCallToolRequest,
  MockMcpToolDefinition,
} from './mock-mcp.types';

/**
 * In-memory mock for the `BaseMcp` discovery + tool-call layer.
 *
 * ### Tool discovery
 * `setTools(serverName, tools)` registers the tool list a given MCP server
 * advertises. The `BaseMcp.initialize` patch reads from this registry; the
 * `toolsMapping()` filter on the real MCP class still applies, so a
 * `readOnly: true` filesystem MCP will only expose the read-side subset.
 *
 * ### Tool calls
 * `onCallTool(matcher, reply)` registers fixtures for `callTool()`. Resolution
 * is the same shape as MockLlm/MockRuntime: most-specific candidate wins,
 * registration order breaks ties. Default: a benign `{content: [{type:
 * 'text', text: '<tool>: ok'}]}` reply (so tests that don't care get a
 * working call).
 */

@Injectable()
export class MockMcpService {
  private toolRegistry = new Map<string, MockMcpToolDefinition[]>();
  private callToolFixtures: MockMcpCallToolFixture[] = [];
  private callRequestLog: MockMcpCallToolRequest[] = [];
  private _callIndex = 0;

  // ---------------------------------------------------------------------------
  // Tool registry
  // ---------------------------------------------------------------------------

  public setTools(
    serverName: string,
    tools: MockMcpToolDefinition[] | readonly MockMcpToolDefinition[],
  ): void {
    this.toolRegistry.set(serverName, [...tools]);
  }

  /**
   * Returns the registered tool list, defaulted to `[]` so an unknown server
   * advertises nothing rather than throwing.
   */
  public getTools(serverName: string): MockMcpToolDefinition[] {
    return this.toolRegistry.get(serverName) ?? [];
  }

  // ---------------------------------------------------------------------------
  // Tool-call fixtures
  // ---------------------------------------------------------------------------

  public onCallTool(
    matcher: MockMcpCallToolMatcher,
    reply: MockMcpCallToolReply,
  ): void {
    this.callToolFixtures.push({ matcher, reply });
  }

  // ---------------------------------------------------------------------------
  // Request log
  // ---------------------------------------------------------------------------

  public getRequests(): MockMcpCallToolRequest[] {
    return [...this.callRequestLog];
  }

  public getLastRequest(): MockMcpCallToolRequest | undefined {
    return this.callRequestLog.at(-1);
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  public reset(): void {
    this.toolRegistry.clear();
    this.callToolFixtures = [];
    this.callRequestLog = [];
    this._callIndex = 0;
  }

  // ---------------------------------------------------------------------------
  // Internal: resolution path used by the patch
  // ---------------------------------------------------------------------------

  /**
   * Resolves a `callTool` invocation to an MCP `CallToolResult`-shaped object.
   * Plain string replies are auto-wrapped into the canonical text-content
   * shape; objects pass through verbatim so tests can return errors with
   * `{ isError: true, content: […] }`.
   */
  public resolveCallTool(
    request: Omit<MockMcpCallToolRequest, 'callIndex'>,
  ): Record<string, unknown> {
    const fullRequest: MockMcpCallToolRequest = {
      ...request,
      callIndex: this._callIndex++,
    };
    this.callRequestLog.push(fullRequest);

    const reply = this.findFixture(fullRequest);
    const materialized =
      reply !== undefined
        ? typeof reply === 'function'
          ? reply(fullRequest)
          : reply
        : `${fullRequest.toolName}: ok`;

    return this.wrapReply(materialized);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private findFixture(
    request: MockMcpCallToolRequest,
  ): MockMcpCallToolReply | undefined {
    const candidates = this.callToolFixtures.filter((f) =>
      this.fixtureMatches(f.matcher, request),
    );
    if (candidates.length === 0) {
      return undefined;
    }

    const best = candidates.reduce((winner, current) =>
      this.specificity(current.matcher) > this.specificity(winner.matcher)
        ? current
        : winner,
    );

    return best.reply;
  }

  private specificity(matcher: MockMcpCallToolMatcher): number {
    let score = 0;
    if (matcher.serverName !== undefined) {
      score += 1;
    }
    if (matcher.toolName !== undefined) {
      score += 1;
    }
    if (matcher.hasArgs !== undefined) {
      score += matcher.hasArgs.length;
    }
    return score;
  }

  private fixtureMatches(
    matcher: MockMcpCallToolMatcher,
    request: MockMcpCallToolRequest,
  ): boolean {
    if (matcher.serverName !== undefined) {
      if (matcher.serverName instanceof RegExp) {
        if (!matcher.serverName.test(request.serverName)) {
          return false;
        }
      } else if (!request.serverName.includes(matcher.serverName)) {
        return false;
      }
    }
    if (
      matcher.toolName !== undefined &&
      matcher.toolName !== request.toolName
    ) {
      return false;
    }
    if (matcher.hasArgs !== undefined) {
      const argKeys = Object.keys(request.args);
      if (!matcher.hasArgs.every((k) => argKeys.includes(k))) {
        return false;
      }
    }
    return true;
  }

  private wrapReply(
    materialized: string | Record<string, unknown>,
  ): Record<string, unknown> {
    if (typeof materialized === 'string') {
      return {
        content: [{ type: 'text', text: materialized }],
        isError: false,
      };
    }
    if ('content' in materialized || 'isError' in materialized) {
      return materialized;
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(materialized) }],
      isError: false,
    };
  }
}
