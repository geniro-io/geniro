import { describe, expect, it } from 'vitest';

import type { BuiltAgentTool } from '../../../agent-tools/tools/base-tool';
import {
  buildBridgeToolDefinitions,
  formatQuestionsAsText,
  isToolForwardableToClaude,
  redactGitUrl,
} from './claude-session.utils';

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

describe('isToolForwardableToClaude', () => {
  it.each([
    'finish',
    'wait_for',
    'tool_search',
    'subagents_run_task',
    'communication_exec',
  ])('never forwards agent-context-bound tool %s', (name) => {
    expect(isToolForwardableToClaude(name)).toBe(false);
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
    'subagents_list',
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
