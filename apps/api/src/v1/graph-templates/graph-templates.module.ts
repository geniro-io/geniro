import { forwardRef, Module, OnModuleInit } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, ModuleRef } from '@nestjs/core';
import { z } from 'zod';

import { AgentMcpModule } from '../agent-mcp/agent-mcp.module';
import { AgentToolsModule } from '../agent-tools/agent-tools.module';
import { AgentTriggersModule } from '../agent-triggers/agent-triggers.module';
import { AgentsModule } from '../agents/agents.module';
import { GitAuthModule } from '../git-auth/git-auth.module';
import { GitRepositoriesModule } from '../git-repositories/git-repositories.module';
import { GraphResourcesModule } from '../graph-resources/graph-resources.module';
import { GraphsModule } from '../graphs/graphs.module';
import { RuntimeModule } from '../runtime/runtime.module';
import { SubagentsModule } from '../subagents/subagents.module';
import { TemplatesController } from './controllers/templates.controller';
import { REGISTER_TEMPLATE_KEY } from './decorators/register-template.decorator';
import { TemplateRegistry } from './services/template-registry';
import { TemplatesService } from './services/templates.service';
import { SimpleAgentTemplate } from './templates/agents/simple-agent.template';
import { NodeBaseTemplate } from './templates/base-node.template';
import { CustomInstructionTemplate } from './templates/instructions/custom-instruction.template';
import { CustomMcpTemplate } from './templates/mcp/custom-mcp.template';
import { FilesystemMcpTemplate } from './templates/mcp/filesystem-mcp.template';
import { JiraMcpTemplate } from './templates/mcp/jira-mcp.template';
import { PlaywrightMcpTemplate } from './templates/mcp/playwright-mcp.template';
import { GithubResourceTemplate } from './templates/resources/github-resource.template';
import { RuntimeTemplate } from './templates/runtimes/runtime.template';
import { AgentCommunicationToolTemplate } from './templates/tools/agent-communication-tool.template';
import { FilesToolTemplate } from './templates/tools/files-tool.template';
import { GhToolTemplate } from './templates/tools/gh-tool.template';
import { KnowledgeToolsTemplate } from './templates/tools/knowledge-tools.template';
import { ShellToolTemplate } from './templates/tools/shell-tool.template';
import { SubagentsToolTemplate } from './templates/tools/subagents-tool.template';
import { WebSearchToolTemplate } from './templates/tools/web-search-tool.template';
import { GitHubIssuesTriggerTemplate } from './templates/triggers/github-issues-trigger.template';
import { ManualTriggerTemplate } from './templates/triggers/manual-trigger.template';

@Module({
  imports: [
    RuntimeModule,
    GitAuthModule,
    AgentToolsModule,
    AgentMcpModule,
    forwardRef(() => AgentsModule),
    AgentTriggersModule,
    GitRepositoriesModule,
    GraphResourcesModule,
    SubagentsModule,
    forwardRef(() => GraphsModule),
    DiscoveryModule,
  ],
  controllers: [TemplatesController],
  providers: [
    TemplateRegistry,
    TemplatesService,
    // --- templates ---
    AgentCommunicationToolTemplate,
    RuntimeTemplate,
    ShellToolTemplate,
    WebSearchToolTemplate,
    KnowledgeToolsTemplate,
    SimpleAgentTemplate,
    GitHubIssuesTriggerTemplate,
    ManualTriggerTemplate,
    GhToolTemplate,
    FilesToolTemplate,
    SubagentsToolTemplate,
    // --- mcp ---
    CustomMcpTemplate,
    FilesystemMcpTemplate,
    JiraMcpTemplate,
    PlaywrightMcpTemplate,
    // --- resources ---
    GithubResourceTemplate,
    // --- instructions ---
    CustomInstructionTemplate,
  ],
  exports: [TemplateRegistry, TemplatesService],
})
export class GraphTemplatesModule implements OnModuleInit {
  constructor(
    private readonly templateRegistry: TemplateRegistry,
    private readonly moduleRef: ModuleRef,
    private readonly discovery: DiscoveryService,
  ) {}

  async onModuleInit() {
    const wrappers = this.discovery.getProviders().filter((w) => w?.metatype);
    for (const w of wrappers) {
      const meta = Reflect.getMetadata(
        REGISTER_TEMPLATE_KEY,
        w.metatype || {},
      ) as unknown;
      if (!meta) {
        continue;
      }

      const instance = (w.instance ??
        this.moduleRef.get(w.token, { strict: false })) as unknown;

      if (!instance) {
        continue;
      }

      this.templateRegistry.register(
        instance as NodeBaseTemplate<z.ZodTypeAny, unknown>,
      );
    }
  }
}
