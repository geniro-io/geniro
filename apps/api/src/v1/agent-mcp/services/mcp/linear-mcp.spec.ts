import { DefaultLogger } from '@packages/common';
import { describe, expect, it } from 'vitest';

import { LinearMcp } from './linear-mcp';

const logger = new DefaultLogger({
  environment: 'test',
  appName: 'test',
  appVersion: '1.0.0',
});

describe('LinearMcp', () => {
  it('builds an mcp-remote stdio config that references the token via the runtime env var', () => {
    const block = new LinearMcp(logger);
    const config = block.getMcpConfig({ token: 'LINEAR_OAUTH_TOKEN' });

    expect(config.name).toBe('linear');
    expect(config.command).toBe('sh');
    const script = config.args[1] ?? '';
    expect(script).toContain('mcp-remote');
    expect(script).toContain('mcp.linear.app');
    // The token value is referenced by env-var name, never embedded literally.
    expect(script).toContain('${LINEAR_OAUTH_TOKEN}');
    expect(script).toContain('Authorization: Bearer');
  });

  it('fails fast (non-zero exit) when the token env var is empty, instead of hanging', () => {
    const block = new LinearMcp(logger);
    const script =
      block.getMcpConfig({ token: 'LINEAR_OAUTH_TOKEN' }).args[1] ?? '';
    // Guard runs BEFORE mcp-remote: an empty/unset token must exit non-zero so
    // the MCP transport closes pre-handshake rather than hanging on an empty
    // Bearer (which would strand the graph compile forever).
    expect(script).toContain('[ -z "${LINEAR_OAUTH_TOKEN}" ]');
    expect(script).toContain('exit 1');
    expect(script.indexOf('exit 1')).toBeLessThan(script.indexOf('mcp-remote'));
  });

  it('rejects a missing or shell-unsafe token reference', () => {
    const block = new LinearMcp(logger);
    expect(() => block.getMcpConfig({ token: '' })).toThrow();
    // A value with spaces / shell metacharacters is not a valid secret name.
    expect(() => block.getMcpConfig({ token: 'bad token; rm -rf' })).toThrow();
    expect(() => block.getMcpConfig({ token: '$(evil)' })).toThrow();
  });

  it('exposes detailed instructions mentioning Linear', () => {
    const block = new LinearMcp(logger);
    expect(block.getDetailedInstructions()).toContain('Linear');
  });
});
