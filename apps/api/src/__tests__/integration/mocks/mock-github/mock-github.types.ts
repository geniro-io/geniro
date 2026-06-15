/**
 * Types for the GitHub HTTP-boundary mock. Mirrors the shape of the MockMcp /
 * MockLlm fixtures: a matcher + a reply, resolved by specificity with
 * registration order breaking ties.
 */

/** A single intercepted GitHub HTTP request, as seen by the fetch patch. */
export interface MockGithubRequest {
  /** Upper-cased HTTP method, e.g. `GET`, `POST`. */
  method: string;
  /** Full request URL, e.g. `https://api.github.com/app/installations/1/access_tokens`. */
  url: string;
  /** Parsed JSON request body, or the raw string / `undefined` when absent. */
  body: unknown;
  /** Monotonic index assigned at resolution time (0-based). */
  requestIndex: number;
}

/** Match criteria for a fixture. Omitted fields match anything. */
export interface MockGithubMatcher {
  /** HTTP method (case-insensitive exact match). */
  method?: string;
  /** Substring (case-insensitive) or RegExp tested against the full URL. */
  urlIncludes?: string | RegExp;
}

/** The response a fixture produces. `status` defaults to 200; `body` is JSON-encoded. */
export interface MockGithubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type MockGithubReply =
  | MockGithubResponse
  | ((request: MockGithubRequest) => MockGithubResponse);

export interface MockGithubFixture {
  matcher: MockGithubMatcher;
  reply: MockGithubReply;
}
