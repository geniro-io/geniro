import { describe, expect, it } from 'vitest';

import { NodeKind } from '../../../graphs/graphs.types';
import {
  LinearMcpTemplate,
  LinearMcpTemplateSchema,
} from './linear-mcp.template';

describe('LinearMcpTemplate', () => {
  it('marks the token field as BOTH a sandbox secret-select and the oauth-authenticate widget', () => {
    const meta = LinearMcpTemplateSchema.shape.token.meta() as
      | Record<string, unknown>
      | undefined;

    // secret-select: the compiler resolves the token and injects it into the
    // runtime env (the value reaches the sandbox where the MCP server runs).
    expect(meta?.['x-ui:secret-select']).toBe(true);
    // oauth-authenticate: the new UI-only marker driving the Authenticate
    // widget. It carries the provider and must NOT be confused with the
    // host-only marker — the compiler's collectSecretNames ignores it.
    expect(meta?.['x-ui:oauth-authenticate']).toEqual({ provider: 'linear' });
    // It is NOT a host-only secret (that marker stays host-side, never sandbox).
    expect(meta?.['x-ui:secret-select-host']).toBeUndefined();
  });

  it('is usable by both the SimpleAgent and the Claude Agent', () => {
    const template = new LinearMcpTemplate(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const inputKinds = template.inputs.map((i) => i.value);
    expect(inputKinds).toContain(NodeKind.SimpleAgent);
    expect(inputKinds).toContain(NodeKind.ClaudeAgent);
    // Requires a Runtime to exec mcp-remote in.
    expect(template.outputs[0]?.value).toBe(NodeKind.Runtime);
    expect(template.outputs[0]?.required).toBe(true);
  });
});
