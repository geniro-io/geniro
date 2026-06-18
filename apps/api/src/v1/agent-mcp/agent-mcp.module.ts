import { Module } from '@nestjs/common';

import { CustomMcp } from './services/mcp/custom-mcp';
import { FilesystemMcp } from './services/mcp/filesystem-mcp';
import { JiraMcp } from './services/mcp/jira-mcp';
import { LinearMcp } from './services/mcp/linear-mcp';
import { PlaywrightMcp } from './services/mcp/playwright-mcp';

@Module({
  providers: [CustomMcp, FilesystemMcp, JiraMcp, LinearMcp, PlaywrightMcp],
  exports: [CustomMcp, FilesystemMcp, JiraMcp, LinearMcp, PlaywrightMcp],
})
export class AgentMcpModule {}
