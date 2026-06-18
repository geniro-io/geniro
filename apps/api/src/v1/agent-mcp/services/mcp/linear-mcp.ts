import { Injectable, Scope } from '@nestjs/common';
import { DefaultLogger } from '@packages/common';
import dedent from 'dedent';

import {
  OAUTH_PROVIDER_CONFIGS,
  OAuthProvider,
} from '../../../oauth-credentials/oauth-credentials.types';
import { IMcpServerConfig } from '../../agent-mcp.types';
import { BaseMcp } from '../base-mcp';

/** Secret-name shape (uppercase snake_case) — also a safe shell identifier. */
const SECRET_REF_REGEX = /^[A-Z][A-Z0-9_]*$/;

export interface LinearMcpConfig {
  /**
   * NAME of the secret holding the Linear OAuth token. Set by the Authenticate
   * widget and resolved by the graph compiler into the runtime env — the token
   * VALUE never travels through this config (or any log).
   */
  token: string;
}

@Injectable({ scope: Scope.TRANSIENT })
export class LinearMcp extends BaseMcp<LinearMcpConfig> {
  constructor(logger: DefaultLogger) {
    super(logger);
  }

  public getMcpConfig(config: LinearMcpConfig): IMcpServerConfig {
    const envName = config.token;
    if (!envName || !SECRET_REF_REGEX.test(envName)) {
      throw new Error(
        'Linear MCP requires an authenticated token — use the Authenticate button',
      );
    }

    const url = OAUTH_PROVIDER_CONFIGS[OAuthProvider.Linear].mcpUrl;
    // The token VALUE is injected into the runtime env under `envName` by the
    // compiler's secret-select resolution; `mcp-remote` reaches the remote
    // Linear MCP endpoint and the Authorization header expands the env var at
    // spawn time. `envName` is a validated identifier (no shell-unsafe chars);
    // the value is validated header-safe at storage time. Keeping the token in
    // the env (never the args) keeps it out of process listings and logs.
    return {
      name: 'linear',
      command: 'sh',
      args: [
        '-c',
        `exec npx -y mcp-remote ${url} --transport http-first --header "Authorization: Bearer \${${envName}}"`,
      ],
      env: {},
    };
  }

  public getDetailedInstructions(): string {
    return dedent`
      ### Linear MCP

      Linear integration via the remote Linear MCP server (OAuth-authenticated).

      Use the available tools to read and manage Linear issues, projects,
      cycles, and comments. Authenticate the node first if the tools are
      unavailable.
    `;
  }
}
