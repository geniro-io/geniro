import { MockMcpService } from './mock-mcp.service';
import { MockMcpToolDefinition } from './mock-mcp.types';

/**
 * Pre-register tool lists for the MCP servers that ship in the codebase.
 *
 * Filesystem MCP carries the full read+write toolset; the `readOnly: true`
 * filter on `FilesystemMcp.toolsMapping()` strips write tools at discovery
 * time, so we just declare everything here and let the production filter
 * decide what the agent sees.
 *
 * Tests can override per-server with `mockMcp.setTools('filesystem', [...])`
 * to customize.
 */

// Schemas mirror the real `@modelcontextprotocol/server-filesystem` MCP shape
// closely enough for langchain's DynamicStructuredTool input validation.
// Full fidelity isn't required — tests only need the parameters they pass to
// validate cleanly.
const PATH_SCHEMA = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
  additionalProperties: true,
};

const FILESYSTEM_MCP_TOOLS: MockMcpToolDefinition[] = [
  {
    name: 'list_allowed_directories',
    description: '[mock] list_allowed_directories',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'list_directory',
    description: '[mock] list_directory',
    inputSchema: PATH_SCHEMA,
  },
  {
    name: 'directory_tree',
    description: '[mock] directory_tree',
    inputSchema: PATH_SCHEMA,
  },
  {
    name: 'search_files',
    description: '[mock] search_files',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        pattern: { type: 'string' },
      },
      required: ['path', 'pattern'],
      additionalProperties: true,
    },
  },
  {
    name: 'get_file_info',
    description: '[mock] get_file_info',
    inputSchema: PATH_SCHEMA,
  },
  {
    name: 'read_text_file',
    description: '[mock] read_text_file',
    inputSchema: PATH_SCHEMA,
  },
  {
    name: 'read_multiple_files',
    description: '[mock] read_multiple_files',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
      },
      required: ['paths'],
      additionalProperties: true,
    },
  },
  {
    name: 'read_media_file',
    description: '[mock] read_media_file',
    inputSchema: PATH_SCHEMA,
  },
  {
    name: 'write_file',
    description: '[mock] write_file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: true,
    },
  },
  {
    name: 'edit_file',
    description: '[mock] edit_file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: { type: 'array' },
        dryRun: { type: 'boolean' },
      },
      required: ['path', 'edits'],
      additionalProperties: true,
    },
  },
  {
    name: 'create_directory',
    description: '[mock] create_directory',
    inputSchema: PATH_SCHEMA,
  },
  {
    name: 'move_file',
    description: '[mock] move_file',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        destination: { type: 'string' },
      },
      required: ['source', 'destination'],
      additionalProperties: true,
    },
  },
];

export const FILESYSTEM_MCP_TOOL_NAMES = FILESYSTEM_MCP_TOOLS.map(
  (t) => t.name,
);

export function applyDefaults(mockMcp: MockMcpService): void {
  mockMcp.setTools('filesystem', FILESYSTEM_MCP_TOOLS);
}
