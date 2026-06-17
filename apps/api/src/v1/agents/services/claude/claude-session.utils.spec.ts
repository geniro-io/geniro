import { describe, expect, it, vi } from 'vitest';

import { environment } from '../../../../environments';
import type { BuiltAgentTool } from '../../../agent-tools/tools/base-tool';
import {
  buildBridgeToolDefinitions,
  buildClaudeSessionEnv,
  collectClaudeKeyModels,
  formatQuestionsAsText,
  isToolForwardableToClaude,
  redactGitUrl,
  sanitizeSandboxError,
  SMALL_FAST_MODEL_ALIAS,
} from './claude-session.utils';

vi.mock('../../../../environments', () => ({
  environment: {
    litellmSandboxUrl: 'http://litellm.sandbox:4000',
    litellmPublicUrl: 'http://litellm.public:4000',
  },
}));

/**
 * redactGitUrl is the last barrier between a private-repo clone URL (which can
 * legitimately embed a PAT) and a Pino/Sentry log line — every case here is a
 * credential-leak pin, not a formatting check.
 */
describe('redactGitUrl', () => {
  it('strips a bare token userinfo', () => {
    expect(redactGitUrl('https://ghp_secret@github.com/acme/repo.git')).toBe(
      'https://***@github.com/acme/repo.git',
    );
  });

  it('strips user:token userinfo', () => {
    expect(
      redactGitUrl('https://user:ghp_secret@github.com/acme/repo.git'),
    ).toBe('https://***@github.com/acme/repo.git');
  });

  it('redacts a password containing an unencoded @ whole (no tail leak)', () => {
    const redacted = redactGitUrl('https://user:p@ss@github.com/acme/repo.git');
    expect(redacted).toBe('https://***@github.com/acme/repo.git');
    // The pre-fix first-`@` stop would have leaked the `ss` password tail.
    expect(redacted).not.toContain('ss@github.com');
    expect(redacted).not.toContain('p@');
  });

  it('leaves a credential-free https URL untouched', () => {
    expect(redactGitUrl('https://github.com/acme/repo.git')).toBe(
      'https://github.com/acme/repo.git',
    );
  });

  it('does not touch ssh-form remotes (no https userinfo)', () => {
    expect(redactGitUrl('git@github.com:acme/repo.git')).toBe(
      'git@github.com:acme/repo.git',
    );
  });

  it('redacts each url independently without crossing a path or whitespace', () => {
    expect(
      redactGitUrl(
        'cloning https://a:tok1@github.com/x/y then https://b:tok2@gitlab.com/p/q',
      ),
    ).toBe(
      'cloning https://***@github.com/x/y then https://***@gitlab.com/p/q',
    );
  });

  it('strips userinfo from a mixed-case https scheme (sandbox git stderr is untrusted)', () => {
    // git stderr — redacted through this function — is sandbox-derived and can
    // echo a URL with an RFC-3986-legal upper/mixed-case scheme. URI schemes
    // are case-insensitive, so `HTTPS://tok@host` is the same credential URL as
    // `https://tok@host` and the token must not survive into a log/Sentry line.
    const redacted = redactGitUrl(
      "fatal: unable to access 'HTTPS://ghp_LEAK@github.com/acme/private'",
    );
    expect(redacted).not.toContain('ghp_LEAK');
  });
});

/**
 * sanitizeSandboxError guards a sandbox-derived `fatal` error string before it
 * reaches a persisted thread message or a Pino/Sentry exception. Both secret
 * shapes a bridge fatal can echo — a clone-URL PAT and a bare `sk-` virtual
 * key — must be masked; redactGitUrl alone catches only the URL.
 */
describe('sanitizeSandboxError', () => {
  it('masks a bare LiteLLM/Anthropic sk- virtual key', () => {
    const redacted = sanitizeSandboxError(
      'LLM proxy rejected key sk-abcd1234EFGH5678_-xyz with 401',
    );
    expect(redacted).not.toContain('sk-abcd1234EFGH5678_-xyz');
    expect(redacted).toContain('sk-***');
  });

  it('masks an sk-ant- prefixed Anthropic key', () => {
    const redacted = sanitizeSandboxError(
      'auth failed: sk-ant-api03-Z9z9z9z9z9',
    );
    expect(redacted).not.toContain('sk-ant-api03-Z9z9z9z9z9');
    expect(redacted).toContain('sk-***');
  });

  it('still strips a PAT-bearing clone URL (composes redactGitUrl)', () => {
    const redacted = sanitizeSandboxError(
      "fatal: unable to access 'https://ghp_LEAK@github.com/acme/private'",
    );
    expect(redacted).not.toContain('ghp_LEAK');
    expect(redacted).toContain('https://***@github.com/acme/private');
  });

  it('redacts both a clone-URL PAT and a virtual key in one string', () => {
    const redacted = sanitizeSandboxError(
      'clone https://x:ghp_LEAK@github.com/a/b failed; then sk-deadBEEF00112233 was rejected',
    );
    expect(redacted).not.toContain('ghp_LEAK');
    expect(redacted).not.toContain('sk-deadBEEF00112233');
    expect(redacted).toContain('https://***@github.com/a/b');
    expect(redacted).toContain('sk-***');
  });

  it('leaves a secret-free error untouched', () => {
    expect(sanitizeSandboxError('bridge exited with code 1')).toBe(
      'bridge exited with code 1',
    );
  });

  it('masks a bare GitHub installation token echoed by the gh CLI (not URL-embedded)', () => {
    // GH_TOKEN is injected into the sandbox session env (buildClaudeSessionEnv)
    // and consumed by TWO sinks: native git over HTTPS (URL-embedded → caught
    // by redactGitUrl) AND the `gh` CLI directly, which surfaces auth errors
    // echoing the bare token value with no surrounding URL. That bare token is
    // a real per-thread sandbox secret; a `gh auth` fatal frame carrying it
    // must not land verbatim in a persisted thread message or a Sentry line.
    const redacted = sanitizeSandboxError(
      'gh: authentication failed for token ghs_AbCdEf0123456789AbCdEf0123456789',
    );
    expect(redacted).not.toContain('ghs_AbCdEf0123456789AbCdEf0123456789');
  });
});

describe('isToolForwardableToClaude', () => {
  it.each([
    'finish',
    'wait_for',
    'tool_search',
    'subagents_list',
    'subagents_run_task',
  ])('never forwards agent-context-bound tool %s', (name) => {
    expect(isToolForwardableToClaude(name)).toBe(false);
  });

  it('forwards communication_exec so a Claude agent can call its connected peers (no SDK-native equivalent)', () => {
    // Unlike subagents (the SDK has its own), peer communication has no native
    // SDK mechanism; a Claude agent wired to a communication-tool node must be
    // able to reach its peers. Its tool usage folds via the standard path.
    expect(isToolForwardableToClaude('communication_exec')).toBe(true);
  });

  it.each(['shell', 'files_read', 'files_write_file', 'files_apply_changes'])(
    'skips Claude-native overlap tool %s',
    (name) => {
      expect(isToolForwardableToClaude(name)).toBe(false);
    },
  );

  it.each([
    'knowledge_search_docs',
    'codebase_search',
    'web_search',
    'gh_clone',
    'thread_store_get',
  ])('forwards regular Geniro tool %s', (name) => {
    expect(isToolForwardableToClaude(name)).toBe(true);
  });
});

describe('buildBridgeToolDefinitions', () => {
  it('maps name/description/__ajvSchema into wire definitions', () => {
    const definitions = buildBridgeToolDefinitions([
      {
        name: 'knowledge_search_docs',
        description: 'Search docs.',
        __ajvSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      } as unknown as BuiltAgentTool,
    ]);

    expect(definitions).toEqual([
      {
        name: 'knowledge_search_docs',
        description: 'Search docs.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    ]);
  });

  it('falls back to an empty object schema when __ajvSchema is missing', () => {
    const definitions = buildBridgeToolDefinitions([
      {
        name: 'bare',
        description: 'No schema.',
      } as unknown as BuiltAgentTool,
    ]);

    expect(definitions[0]?.inputSchema).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('buildClaudeSessionEnv', () => {
  it('always carries the virtual key as the Anthropic API key', () => {
    const env = buildClaudeSessionEnv('vk_test');
    expect(env.ANTHROPIC_API_KEY).toBe('vk_test');
  });

  it('omits GH_TOKEN when no GitHub token is supplied', () => {
    expect(buildClaudeSessionEnv('vk_test')).not.toHaveProperty('GH_TOKEN');
  });

  it('injects GH_TOKEN when a GitHub token is supplied', () => {
    const env = buildClaudeSessionEnv('vk_test', 'ghs_install_token');
    expect(env.GH_TOKEN).toBe('ghs_install_token');
  });

  it('omits GH_TOKEN for an empty-string token (no half-wired credential)', () => {
    expect(buildClaudeSessionEnv('vk_test', '')).not.toHaveProperty('GH_TOKEN');
  });

  it('omits GH_TOKEN for a null token', () => {
    expect(buildClaudeSessionEnv('vk_test', null)).not.toHaveProperty(
      'GH_TOKEN',
    );
  });

  it('points ANTHROPIC_BASE_URL at the sandbox LiteLLM URL for a local runtime', () => {
    const env = buildClaudeSessionEnv('vk_test');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://litellm.sandbox:4000');
  });

  it('points ANTHROPIC_BASE_URL at the public LiteLLM URL for a remote (Daytona) runtime', () => {
    const env = buildClaudeSessionEnv('vk_test', null, {
      isRemoteRuntime: true,
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://litellm.public:4000');
  });

  it('fails closed when a remote runtime has no public LiteLLM URL configured', () => {
    const original = environment.litellmPublicUrl;
    (environment as { litellmPublicUrl: string }).litellmPublicUrl = '';
    try {
      expect(() =>
        buildClaudeSessionEnv('vk_test', null, { isRemoteRuntime: true }),
      ).toThrow(/LITELLM_PUBLIC_URL is not configured/);
    } finally {
      (environment as { litellmPublicUrl: string }).litellmPublicUrl = original;
    }
  });

  it('uses the BYO override base URL with the supplied key (direct Anthropic)', () => {
    const env = buildClaudeSessionEnv('sk-ant-api03-byo', null, {
      anthropicBaseUrlOverride: 'https://api.anthropic.com',
    });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-byo');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
  });

  it('does NOT fail closed on a missing LiteLLM URL when a BYO base-URL override is supplied', () => {
    // BYO talks to Anthropic directly and never reads the LiteLLM sandbox URL,
    // so the override path must bypass the CLAUDE_*_LLM_URL_MISSING fail-close.
    const originalSandbox = environment.litellmSandboxUrl;
    const originalPublic = environment.litellmPublicUrl;
    (environment as { litellmSandboxUrl: string }).litellmSandboxUrl = '';
    (environment as { litellmPublicUrl: string }).litellmPublicUrl = '';
    try {
      const env = buildClaudeSessionEnv('sk-ant-api03-byo', null, {
        anthropicBaseUrlOverride: 'https://api.anthropic.com',
      });
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    } finally {
      (environment as { litellmSandboxUrl: string }).litellmSandboxUrl =
        originalSandbox;
      (environment as { litellmPublicUrl: string }).litellmPublicUrl =
        originalPublic;
    }
  });

  it('emits ANTHROPIC_DEFAULT_HAIKU_MODEL by default and drops the deprecated SMALL_FAST var', () => {
    const env = buildClaudeSessionEnv('vk_test');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(SMALL_FAST_MODEL_ALIAS);
    expect(env).not.toHaveProperty('ANTHROPIC_SMALL_FAST_MODEL');
  });

  it('omits the optional alias-override vars when no overrides are supplied', () => {
    const env = buildClaudeSessionEnv('vk_test');
    expect(env).not.toHaveProperty('ANTHROPIC_DEFAULT_SONNET_MODEL');
    expect(env).not.toHaveProperty('ANTHROPIC_DEFAULT_OPUS_MODEL');
    expect(env).not.toHaveProperty('ANTHROPIC_DEFAULT_FABLE_MODEL');
    expect(env).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL');
  });

  it('maps each supplied alias override onto its ANTHROPIC_DEFAULT_*_MODEL / subagent env var', () => {
    const env = buildClaudeSessionEnv('vk_test', null, {
      modelOverrides: {
        sonnet: 'claude-sonnet-4-6',
        opus: 'claude-opus-4-8',
        haiku: 'claude-haiku-custom',
        fable: 'claude-fable-5',
        subagent: 'claude-sonnet-4-6',
      },
    });
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-4-6');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-8');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-custom');
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('claude-fable-5');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('claude-sonnet-4-6');
  });
});

describe('collectClaudeKeyModels', () => {
  it('always includes the main model and the default haiku/background model', () => {
    expect(collectClaudeKeyModels('claude-opus-4-8')).toEqual([
      'claude-opus-4-8',
      SMALL_FAST_MODEL_ALIAS,
    ]);
  });

  it('adds every set alias override and dedupes shared names', () => {
    const models = collectClaudeKeyModels('claude-opus-4-8', {
      sonnet: 'claude-sonnet-4-6',
      haiku: 'claude-haiku-4-5',
      subagent: 'claude-opus-4-8',
    });
    expect(models).toContain('claude-opus-4-8');
    expect(models).toContain('claude-sonnet-4-6');
    expect(models).toContain('claude-haiku-4-5');
    expect(new Set(models).size).toBe(models.length);
  });

  it('scopes the haiku override (not the default) into the key models', () => {
    const models = collectClaudeKeyModels('claude-opus-4-8', {
      haiku: 'claude-haiku-custom',
    });
    expect(models).toEqual(['claude-opus-4-8', 'claude-haiku-custom']);
    expect(models).not.toContain(SMALL_FAST_MODEL_ALIAS);
  });
});

describe('formatQuestionsAsText', () => {
  it('renders questions with labeled options', () => {
    expect(
      formatQuestionsAsText([
        {
          question: 'Which DB?',
          options: [
            { label: 'Postgres', description: 'relational' },
            { label: 'MySQL' },
          ],
        },
        { question: 'Deploy now?' },
      ]),
    ).toBe('Which DB?\n- Postgres: relational\n- MySQL\n\nDeploy now?');
  });

  it('falls back to an explanatory line when no question text survived sanitization', () => {
    expect(formatQuestionsAsText([])).toContain('could not be read');
    expect(formatQuestionsAsText([{ header: 'DB' }])).toContain(
      'could not be read',
    );
  });
});
