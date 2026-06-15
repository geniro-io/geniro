import { MockGithubService } from './mock-github.service';

/**
 * Optional happy-path fixtures for tests that exercise the CONFIGURED GitHub
 * path and want successful responses. NOT auto-applied by `createTestModule`:
 * the hermetic baseline is "no fixture → 404", so the not-found / cannot-issue
 * test paths stay deterministic without any setup. Apply AFTER per-test
 * fixtures only if you need the defaults.
 */
export const applyGithubDefaults = (svc: MockGithubService): void => {
  // Successful installation access-token issuance.
  svc.onRequest(
    { method: 'POST', urlIncludes: '/access_tokens' },
    {
      status: 201,
      body: {
        token: 'ghs_mock_installation_token',
        expires_at: '2099-01-01T00:00:00Z',
        permissions: { contents: 'read', metadata: 'read' },
      },
    },
  );
  // Successful app metadata lookup (`GET /app`).
  svc.onRequest(
    { method: 'GET', urlIncludes: '/app' },
    { status: 200, body: { slug: 'mock-app', id: 1 } },
  );
};
