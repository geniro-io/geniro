/* eslint-disable @typescript-eslint/naming-convention -- internal counter needs leading underscore */
import { Injectable } from '@nestjs/common';

import {
  MockGithubFixture,
  MockGithubMatcher,
  MockGithubReply,
  MockGithubRequest,
  MockGithubResponse,
} from './mock-github.types';

/**
 * In-memory mock for the GitHub HTTP boundary. The `installMockGithubPatch`
 * fetch patch routes every request to `api.github.com` / `github.com` through
 * `resolve()`, so Octokit (`@octokit/rest`) and the raw `fetch()` calls in
 * `GitHubAppService` are both intercepted — no real network reaches GitHub
 * from the hermetic integration suite.
 *
 * Resolution mirrors MockMcp/MockLlm: the most-specific matching fixture wins,
 * registration order breaks ties. With NO matching fixture the default is a
 * `404` (so an unconfigured/invalid GitHub call deterministically rejects,
 * which is exactly what the not-found/cannot-issue test paths expect). Tests
 * opt into success by registering a fixture, e.g.
 * `onRequest({ method: 'POST', urlIncludes: 'access_tokens' }, { status: 201,
 * body: { token: 'mock', expires_at: '...' } })`.
 */
@Injectable()
export class MockGithubService {
  private fixtures: MockGithubFixture[] = [];
  private requestLog: MockGithubRequest[] = [];
  private _requestIndex = 0;

  public onRequest(matcher: MockGithubMatcher, reply: MockGithubReply): void {
    this.fixtures.push({ matcher, reply });
  }

  public getRequests(): MockGithubRequest[] {
    return [...this.requestLog];
  }

  public getLastRequest(): MockGithubRequest | undefined {
    return this.requestLog.at(-1);
  }

  public reset(): void {
    this.fixtures = [];
    this.requestLog = [];
    this._requestIndex = 0;
  }

  /** Resolution path used by the fetch patch. */
  public resolve(
    request: Omit<MockGithubRequest, 'requestIndex'>,
  ): MockGithubResponse {
    const fullRequest: MockGithubRequest = {
      ...request,
      requestIndex: this._requestIndex++,
    };
    this.requestLog.push(fullRequest);

    const reply = this.findFixture(fullRequest);
    if (reply === undefined) {
      return {
        status: 404,
        body: { message: 'Not Found (mock-github: no fixture registered)' },
      };
    }
    return typeof reply === 'function' ? reply(fullRequest) : reply;
  }

  private findFixture(request: MockGithubRequest): MockGithubReply | undefined {
    const candidates = this.fixtures.filter((f) =>
      this.fixtureMatches(f.matcher, request),
    );
    if (candidates.length === 0) {
      return undefined;
    }
    const best = candidates.reduce((winner, current) =>
      this.specificity(current.matcher) > this.specificity(winner.matcher)
        ? current
        : winner,
    );
    return best.reply;
  }

  private specificity(matcher: MockGithubMatcher): number {
    let score = 0;
    if (matcher.method !== undefined) {
      score += 1;
    }
    if (matcher.urlIncludes !== undefined) {
      score += 1;
    }
    return score;
  }

  private fixtureMatches(
    matcher: MockGithubMatcher,
    request: MockGithubRequest,
  ): boolean {
    if (
      matcher.method !== undefined &&
      matcher.method.toUpperCase() !== request.method
    ) {
      return false;
    }
    if (matcher.urlIncludes !== undefined) {
      if (matcher.urlIncludes instanceof RegExp) {
        if (!matcher.urlIncludes.test(request.url)) {
          return false;
        }
      } else if (
        !request.url.toLowerCase().includes(matcher.urlIncludes.toLowerCase())
      ) {
        return false;
      }
    }
    return true;
  }
}
