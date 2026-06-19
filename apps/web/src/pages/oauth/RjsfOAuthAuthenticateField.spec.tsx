// @vitest-environment jsdom
import type { FieldProps, RJSFSchema } from '@rjsf/utils';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { statusMock, startMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  startMock: vi.fn(),
}));

// Only the network client is stubbed — `isOAuthSuccessMessage` and
// `OAUTH_BROADCAST_CHANNEL` come from the REAL module so this test exercises
// the production guard rather than a hand-copied (drift-prone) reimplementation.
vi.mock('./oauth-api', async () => {
  const actual =
    await vi.importActual<typeof import('./oauth-api')>('./oauth-api');
  return {
    ...actual,
    oauthApi: { status: statusMock, start: startMock },
  };
});

import { RjsfOAuthAuthenticateField } from './RjsfOAuthAuthenticateField';

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  close = vi.fn();
  constructor(public readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }
}

type Ctx = { graphId?: string; nodeId?: string };

const makeProps = (
  overrides: Partial<FieldProps<unknown, RJSFSchema, Ctx>> = {},
): FieldProps<unknown, RJSFSchema, Ctx> =>
  ({
    schema: {
      title: 'Linear authentication',
      'x-ui:oauth-authenticate': { provider: 'linear' },
    } as RJSFSchema,
    formData: undefined,
    onChange: vi.fn(),
    formContext: { graphId: 'g1', nodeId: 'n1' },
    fieldPathId: { path: ['token'] },
    name: 'token',
    disabled: false,
    readonly: false,
    required: false,
    ...overrides,
  }) as unknown as FieldProps<unknown, RJSFSchema, Ctx>;

const unauthenticated = {
  data: {
    provider: 'linear',
    authenticated: false,
    accountLabel: null,
    secretName: null,
  },
};
const authenticated = {
  data: {
    provider: 'linear',
    authenticated: true,
    accountLabel: 'Acme Workspace',
    secretName: 'LINEAR_OAUTH_TOKEN',
  },
};

describe('RjsfOAuthAuthenticateField', () => {
  beforeEach(() => {
    statusMock.mockReset();
    startMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeBroadcastChannel.instances = [];
  });

  it('opens a blank tab synchronously then navigates it to the authorize URL', async () => {
    statusMock.mockResolvedValue(unauthenticated);
    startMock.mockResolvedValue({
      data: { authorizeUrl: 'https://linear.app/oauth/authorize?x=1' },
    });
    const fakeTab = { location: { href: '' }, close: vi.fn() };
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(fakeTab as unknown as Window);

    render(<RjsfOAuthAuthenticateField {...makeProps()} />);

    const button = await screen.findByRole('button', { name: /authenticate/i });
    fireEvent.click(button);

    // Blank tab opened synchronously in the click handler (popup-safe).
    expect(openSpy).toHaveBeenCalledWith('', '_blank');
    // /start passes the editor context for the resume target.
    await waitFor(() =>
      expect(startMock).toHaveBeenCalledWith('linear', 'g1', 'n1'),
    );
    await waitFor(() =>
      expect(fakeTab.location.href).toBe(
        'https://linear.app/oauth/authorize?x=1',
      ),
    );
  });

  it('falls back to a link when the popup is blocked (window.open returns null)', async () => {
    statusMock.mockResolvedValue(unauthenticated);
    startMock.mockResolvedValue({
      data: { authorizeUrl: 'https://linear.app/oauth/authorize?y=2' },
    });
    vi.spyOn(window, 'open').mockReturnValue(null);

    render(<RjsfOAuthAuthenticateField {...makeProps()} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /authenticate/i }),
    );

    const link = await screen.findByTestId('oauth-fallback-link');
    expect(link.getAttribute('href')).toBe(
      'https://linear.app/oauth/authorize?y=2',
    );
  });

  it('refreshes the auth-state on a cross-tab oauth-success message', async () => {
    statusMock.mockResolvedValueOnce(unauthenticated);
    const onChange = vi.fn();
    render(<RjsfOAuthAuthenticateField {...makeProps({ onChange })} />);

    await screen.findByRole('button', { name: /^authenticate$/i });

    // The callback tab posts to the opener; the widget re-queries /status.
    statusMock.mockResolvedValueOnce(authenticated);
    fireEvent(
      window,
      new MessageEvent('message', {
        data: {
          type: 'oauth-success',
          provider: 'linear',
          accountLabel: 'Acme Workspace',
        },
        origin: window.location.origin,
      }),
    );

    await screen.findByTestId('oauth-authenticated-label');
    expect(screen.getByText(/Authenticated as Acme Workspace/)).toBeTruthy();
    // The resolved secret name is wired into the field value for the compiler.
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith('LINEAR_OAUTH_TOKEN', ['token']),
    );
  });

  it('refreshes the auth-state on a BroadcastChannel oauth-success message', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    statusMock.mockResolvedValueOnce(unauthenticated);
    const onChange = vi.fn();
    render(<RjsfOAuthAuthenticateField {...makeProps({ onChange })} />);

    await screen.findByRole('button', { name: /^authenticate$/i });

    // The widget subscribes to the cross-tab channel; the callback page (in the
    // other tab) broadcasts the success message on it.
    const channel = FakeBroadcastChannel.instances.find(
      (c) => c.name === 'oauth',
    );
    expect(channel).toBeTruthy();

    statusMock.mockResolvedValueOnce(authenticated);
    await act(async () => {
      channel?.onmessage?.(
        new MessageEvent('message', {
          data: {
            type: 'oauth-success',
            provider: 'linear',
            accountLabel: 'Acme Workspace',
          },
        }),
      );
    });

    await screen.findByTestId('oauth-authenticated-label');
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith('LINEAR_OAUTH_TOKEN', ['token']),
    );
  });

  it('ignores a message from a foreign origin', async () => {
    statusMock.mockResolvedValue(unauthenticated);
    render(<RjsfOAuthAuthenticateField {...makeProps()} />);
    await screen.findByRole('button', { name: /^authenticate$/i });

    const callsBefore = statusMock.mock.calls.length;
    fireEvent(
      window,
      new MessageEvent('message', {
        data: { type: 'oauth-success', provider: 'linear' },
        origin: 'https://evil.example.com',
      }),
    );
    // No extra status refresh — the foreign-origin message is dropped.
    expect(statusMock.mock.calls.length).toBe(callsBefore);
  });
});
