// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { exchangeMock } = vi.hoisted(() => ({ exchangeMock: vi.fn() }));

// Stub only the network client; keep the real OAUTH_BROADCAST_CHANNEL constant.
vi.mock('../oauth-api', async () => {
  const actual =
    await vi.importActual<typeof import('../oauth-api')>('../oauth-api');
  return {
    ...actual,
    oauthApi: { exchange: exchangeMock },
  };
});

import { OAuthCallbackPage } from './OAuthCallbackPage';

const openerPost = vi.fn();
const broadcastPost = vi.fn();
const broadcastClose = vi.fn();
const closeSpy = vi.fn();

class FakeBroadcastChannel {
  postMessage = broadcastPost;
  close = broadcastClose;
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(public readonly name: string) {}
}

const renderAt = (path: string, strict = false) => {
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/oauth/callback/:provider"
          element={<OAuthCallbackPage />}
        />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
};

// Let the awaited exchange + the follow-up state update settle.
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('OAuthCallbackPage', () => {
  beforeEach(() => {
    exchangeMock.mockReset();
    openerPost.mockReset();
    broadcastPost.mockReset();
    broadcastClose.mockReset();
    closeSpy.mockReset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    Object.defineProperty(window, 'opener', {
      value: { postMessage: openerPost },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'close', {
      value: closeSpy,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('exchanges the code, signals the opener + broadcast, and schedules self-close', async () => {
    exchangeMock.mockResolvedValue({
      data: { provider: 'linear', accountLabel: 'Acme Workspace' },
    });
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');

    renderAt('/oauth/callback/linear?code=the-code&state=the-state');
    await flush();

    expect(exchangeMock).toHaveBeenCalledWith({
      provider: 'linear',
      code: 'the-code',
      state: 'the-state',
    });
    const expectedMessage = {
      type: 'oauth-success',
      provider: 'linear',
      accountLabel: 'Acme Workspace',
    };
    expect(openerPost).toHaveBeenCalledWith(
      expectedMessage,
      window.location.origin,
    );
    expect(broadcastPost).toHaveBeenCalledWith(expectedMessage);
    expect(broadcastClose).toHaveBeenCalled();
    expect(screen.getByText('Connected')).toBeTruthy();

    // A self-close is scheduled (best-effort, fires for a script-opened tab).
    const closeCall = setTimeoutSpy.mock.calls.find(
      ([, delay]) => delay === 1200,
    );
    expect(closeCall).toBeTruthy();
    (closeCall?.[0] as () => void)();
    expect(closeSpy).toHaveBeenCalled();
  });

  it('shows an error and never exchanges when code/state are missing', async () => {
    renderAt('/oauth/callback/linear');
    await flush();

    expect(screen.getByText(/Missing provider, code, or state/i)).toBeTruthy();
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it('renders the extracted error message when the exchange rejects', async () => {
    exchangeMock.mockRejectedValue(new Error('Boom'));

    renderAt('/oauth/callback/linear?code=c&state=s');
    await flush();

    expect(screen.getByText('Authentication Failed')).toBeTruthy();
    expect(screen.getByText('Authentication failed: Boom')).toBeTruthy();
  });

  it('runs the exchange exactly once even under StrictMode double-invoke', async () => {
    exchangeMock.mockResolvedValue({
      data: { provider: 'linear', accountLabel: null },
    });

    renderAt('/oauth/callback/linear?code=c&state=s', true);
    await flush();

    expect(exchangeMock).toHaveBeenCalledTimes(1);
  });
});
