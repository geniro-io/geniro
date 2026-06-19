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
