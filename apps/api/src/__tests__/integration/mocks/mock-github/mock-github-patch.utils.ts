import { MockGithubRequest } from './mock-github.types';
import { getMockGithubService } from './mock-github-singleton.utils';

type FetchFn = typeof globalThis.fetch;

interface PatchedGlobal {
  __mockGithubOrigFetch?: FetchFn;
}

// Hosts routed through the mock. Git clone/push use the `git` CLI (child
// process), NOT fetch, so intercepting these hosts only catches the REST API
// (api.github.com — Octokit) and the OAuth/GraphQL calls (github.com) — never
// a git transfer.
const GITHUB_HOSTS = new Set(['api.github.com', 'github.com']);

const isGithubUrl = (url: string): boolean => {
  // Fast path: skip the (relatively expensive) URL parse for the overwhelming
  // majority of fetches that aren't GitHub at all (e.g. the Qdrant client's
  // per-request HTTP calls). Only parse to confirm the host once the cheap
  // substring check passes.
  if (!url.includes('github.com')) {
    return false;
  }
  try {
    return GITHUB_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
};

const extractUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

const extractMethod = (
  input: RequestInfo | URL,
  init?: RequestInit,
): string => {
  if (init?.method) {
    return init.method.toUpperCase();
  }
  if (
    typeof input === 'object' &&
    input !== null &&
    'method' in input &&
    typeof (input as Request).method === 'string'
  ) {
    return (input as Request).method.toUpperCase();
  }
  return 'GET';
};

const extractBody = (init?: RequestInit): unknown => {
  const raw = init?.body;
  if (raw == null || typeof raw !== 'string') {
    return raw ?? undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/**
 * Patch `globalThis.fetch` so GitHub HTTP calls are served by the current
 * app's `MockGithubService` instead of hitting the network. Idempotent and
 * persistent (mirrors the `BaseMcp` prototype patch): non-GitHub URLs and any
 * request made while no MockGithubService is registered fall through to the
 * original fetch, so non-GitHub tests are unaffected.
 */
export function installMockGithubPatch(): void {
  const g = globalThis as unknown as PatchedGlobal;
  if (g.__mockGithubOrigFetch) {
    return;
  }
  // Escape hatch: a global opt-out for debugging (e.g. to A/B the patch's
  // effect on suite timing). When set, fetch is left untouched and GitHub calls
  // hit the real network.
  if (process.env.GENIRO_TEST_DISABLE_MOCK_GITHUB === 'true') {
    return;
  }
  const orig = globalThis.fetch.bind(globalThis);
  g.__mockGithubOrigFetch = orig;

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const svc = getMockGithubService();
    if (!svc) {
      return orig(input, init);
    }
    const url = extractUrl(input);
    if (!isGithubUrl(url)) {
      return orig(input, init);
    }
    const request: Omit<MockGithubRequest, 'requestIndex'> = {
      method: extractMethod(input, init),
      url,
      body: extractBody(init),
    };
    const reply = svc.resolve(request);
    const status = reply.status ?? 200;
    const headers = {
      'content-type': 'application/json',
      ...(reply.headers ?? {}),
    };
    const bodyText =
      reply.body === undefined
        ? ''
        : typeof reply.body === 'string'
          ? reply.body
          : JSON.stringify(reply.body);
    return new Response(bodyText, { status, headers });
  }) as FetchFn;
}

export function uninstallMockGithubPatch(): void {
  const g = globalThis as unknown as PatchedGlobal;
  if (g.__mockGithubOrigFetch) {
    globalThis.fetch = g.__mockGithubOrigFetch;
    delete g.__mockGithubOrigFetch;
  }
}
