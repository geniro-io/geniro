import { createRequire } from 'node:module';

import { ToolRunnableConfig } from '@langchain/core/tools';
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { ZodSchema } from 'zod';

import {
  BaseTool,
  ExtendedLangGraphRunnableConfig,
  JSONSchema,
  ToolInvokeResult,
} from '../../agent-tools/tools/base-tool';
import { BaseAgentConfigurable } from '../../agents/agents.types';
import { McpToolMetadata } from './base-mcp';

type CallToolHandler = (
  toolName: string,
  args: Record<string, unknown>,
  cfg: ToolRunnableConfig<BaseAgentConfigurable>,
) => Promise<unknown>;

export class BaseMcpTool<TSchema, TConfig = unknown> extends BaseTool<
  TSchema,
  TConfig
> {
  public name = '';
  public description = '';

  public get schema() {
    const require = createRequire(__filename);
    const { jsonSchemaToZod } = require('@n8n/json-schema-to-zod') as {
      jsonSchemaToZod: (schema: unknown) => ZodSchema;
    };

    return jsonSchemaToZod(this.tool.inputSchema);
  }

  /**
   * Returns the original MCP JSON Schema directly, bypassing the lossy
   * Zod round-trip (jsonSchemaToZod may produce transforms/nullable that
   * cannot be converted back to JSON Schema).
   *
   * Forces the draft-07 `$schema` annotation so consumers (e.g. graph node
   * metadata, /templates) receive a consistent schema dialect — MCP servers
   * are not required to emit `$schema`, and matching `zodToAjvSchema`'s
   * draft-07 output keeps tool-list payloads uniform across tool sources.
   */
  public override get ajvSchema(): JSONSchema {
    const raw = (this.tool.inputSchema ?? {}) as JSONSchema;
    return {
      $schema: 'http://json-schema.org/draft-07/schema#',
      ...raw,
    };
  }

  constructor(
    private readonly tool: ListToolsResult['tools'][number],
    private readonly callTool: CallToolHandler,
    private readonly metadata: McpToolMetadata | undefined,
  ) {
    super();

    this.name = tool.name;
    this.description = tool.description || '';
  }

  protected override generateTitle(args: unknown, _config: TConfig): string {
    return (
      this.metadata?.generateTitle?.(args as Record<string, unknown>) || ''
    );
  }

  public getDetailedInstructions(
    _config: TConfig,
    _lgConfig?: ExtendedLangGraphRunnableConfig,
  ) {
    return this.metadata?.getDetailedInstructions?.() || '';
  }

  public async invoke(
    data: TSchema,
    config: TConfig,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<ToolInvokeResult<string>> {
    const title = this.generateTitle(data, config);

    try {
      const result = await this.callTool(
        this.tool.name,
        data as Record<string, unknown>,
        cfg,
      );

      // Extract text content from CallToolResult
      let output = 'No result returned';
      if (
        result &&
        typeof result === 'object' &&
        'content' in result &&
        Array.isArray((result as { content?: unknown }).content)
      ) {
        const content = (
          result as { content: { type?: string; text?: string }[] }
        ).content;
        const textContent = content
          .filter(
            (item: { type?: string }): item is { type: 'text'; text: string } =>
              item.type === 'text',
          )
          .map((item) => item.text || '')
          .join('\n');
        output = textContent || JSON.stringify(content);
      }

      return {
        output,
        messageMetadata: {
          __title: title,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        output: `Error executing MCP tool: ${errorMessage}`,
        messageMetadata: {
          __title: title,
        },
      };
    }
  }
}
