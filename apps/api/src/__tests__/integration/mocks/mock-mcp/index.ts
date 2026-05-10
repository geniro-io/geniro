import type { INestApplication } from '@nestjs/common';

import { MockMcpService } from './mock-mcp.service';

export { MockMcpModule } from './mock-mcp.module';
export { MockMcpService } from './mock-mcp.service';
export type {
  MockMcpCallToolFixture,
  MockMcpCallToolMatcher,
  MockMcpCallToolReply,
  MockMcpCallToolRequest,
  MockMcpToolDefinition,
} from './mock-mcp.types';
export {
  applyDefaults,
  FILESYSTEM_MCP_TOOL_NAMES,
} from './mock-mcp-defaults.utils';
export {
  installMockMcpPatch,
  uninstallMockMcpPatch,
} from './mock-mcp-patch.utils';
export {
  getMockMcpService,
  setMockMcpService,
} from './mock-mcp-singleton.utils';

export const getMockMcp = (app: INestApplication): MockMcpService =>
  app.get(MockMcpService);
