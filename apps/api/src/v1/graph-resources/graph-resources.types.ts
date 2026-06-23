import type { ToolRunnableConfig } from '@langchain/core/tools';

import type { BaseAgentConfigurable } from '../agents/agents.types';

export type ResourceResolveContext = ToolRunnableConfig<BaseAgentConfigurable>;

export enum GitHubAuthMethod {
  GithubApp = 'github_app',
  Pat = 'pat',
}

export interface ShellResourceData {
  resolveEnv: (ctx?: ResourceResolveContext) => Promise<Record<string, string>>;
  initScript?: string[] | string;
  initScriptTimeout?: number;
}

export interface IBaseResourceOutput<T = unknown> {
  information: string;
  kind: ResourceKind;
  data: T;
}

export interface IShellResourceOutput extends IBaseResourceOutput<ShellResourceData> {}

export enum ResourceKind {
  Shell = 'Shell',
}
