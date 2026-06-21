// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listMock,
  startMock,
  disconnectMock,
  toastErrorMock,
  toastSuccessMock,
} = vi.hoisted(() => ({
  listMock: vi.fn(),
  startMock: vi.fn(),
  disconnectMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

// Stub only the network client; keep the real cross-tab guards.
vi.mock('./oauth-api', async () => {
  const actual =
    await vi.importActual<typeof import('./oauth-api')>('./oauth-api');
  return {
    ...actual,
    oauthApi: {
      listOAuthCredentials: listMock,
      start: startMock,
      disconnectOAuthCredential: disconnectMock,
    },
  };
});

// Capture toasts so the error/success paths are assertable.
vi.mock('sonner', () => ({
  toast: { error: toastErrorMock, success: toastSuccessMock },
}));

// The page only reads the project to keep the header in sync — stub it so the
// test needs no Router / ProjectProvider wrapper.
vi.mock('@/hooks/useCurrentProject', () => ({
  useCurrentProject: () => ({
    projectId: 'p1',
    currentProject: null,
    projects: [],
    loading: false,
    loadProjects: vi.fn(),
  }),
}));

import { webSocketService } from '../../services/WebSocketService';
import type { SocketNotification } from '../../services/WebSocketTypes';
import { ConnectionsPage } from './ConnectionsPage';

const connected = {
  provider: 'linear',
  authenticated: true,
  accountLabel: 'Acme Workspace',
  secretName: 'LINEAR_OAUTH_TOKEN',
  expiresAt: null,
};

describe('ConnectionsPage', () => {
  beforeEach(() => {
    listMock.mockReset();
    startMock.mockReset();
    disconnectMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders a not-connected card with a Connect button when the project has no credentials', async () => {
    listMock.mockResolvedValue({ data: [] });

    render(<ConnectionsPage />);

    const card = await screen.findByTestId('connection-card-linear');
    expect(within(card).getByText('Linear')).toBeTruthy();
    // Exact string targets the Badge only (the description is "Not connected.").
    expect(within(card).getByText('Not connected')).toBeTruthy();
    expect(
      within(card).getByRole('button', { name: /^connect$/i }),
    ).toBeTruthy();
  });

  it('renders a connected card with the account label + a Disconnect button', async () => {
    listMock.mockResolvedValue({ data: [connected] });

    render(<ConnectionsPage />);

    const card = await screen.findByTestId('connection-card-linear');
    expect(
      within(card).getByText(/Authenticated as Acme Workspace/),
    ).toBeTruthy();
    expect(
      within(card).getByRole('button', { name: /disconnect/i }),
    ).toBeTruthy();
    expect(
      within(card).getByRole('button', { name: /reconnect/i }),
    ).toBeTruthy();
  });

  it('opens a blank tab and starts the flow on Connect', async () => {
    listMock.mockResolvedValue({ data: [] });
    startMock.mockResolvedValue({
      data: { authorizeUrl: 'https://linear.app/oauth/authorize?c=1' },
    });
    const fakeTab = { location: { href: '' }, close: vi.fn() };
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(fakeTab as unknown as Window);

    render(<ConnectionsPage />);
    const card = await screen.findByTestId('connection-card-linear');
    fireEvent.click(within(card).getByRole('button', { name: /^connect$/i }));

    expect(openSpy).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(startMock).toHaveBeenCalledWith('linear'));
    await waitFor(() =>
      expect(fakeTab.location.href).toBe(
        'https://linear.app/oauth/authorize?c=1',
      ),
    );
  });

  it('disconnects after confirming the dialog', async () => {
    listMock.mockResolvedValue({ data: [connected] });
    disconnectMock.mockResolvedValue(undefined);

    render(<ConnectionsPage />);
    const card = await screen.findByTestId('connection-card-linear');
    fireEvent.click(within(card).getByRole('button', { name: /disconnect/i }));

    // Confirm in the dialog (a separate Disconnect action button).
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: /disconnect/i }),
    );

    await waitFor(() => expect(disconnectMock).toHaveBeenCalledWith('linear'));
  });

  it('live-refreshes on a credential.acquired project-room event', async () => {
    // First load: not connected. After the event: connected.
    listMock.mockResolvedValueOnce({ data: [] });
    render(<ConnectionsPage />);

    const card = await screen.findByTestId('connection-card-linear');
    // Exact string targets the Badge only (the description is "Not connected.").
    expect(within(card).getByText('Not connected')).toBeTruthy();

    listMock.mockResolvedValueOnce({ data: [connected] });
    act(() => {
      webSocketService._unsafeInjectEventForHarness('credential.acquired', {
        projectId: 'p1',
        data: { provider: 'linear', accountLabel: 'Acme Workspace' },
      } as unknown as SocketNotification);
    });

    await waitFor(() =>
      expect(screen.getByText(/Authenticated as Acme Workspace/)).toBeTruthy(),
    );
  });

  it('names the account in the disconnect confirmation dialog', async () => {
    listMock.mockResolvedValue({ data: [connected] });

    render(<ConnectionsPage />);
    const card = await screen.findByTestId('connection-card-linear');
    fireEvent.click(within(card).getByRole('button', { name: /disconnect/i }));

    const dialog = await screen.findByRole('alertdialog');
    // The dialog names the account being disconnected, not just the provider.
    expect(within(dialog).getByText(/\(Acme Workspace\)/)).toBeTruthy();
  });

  it('keeps the dialog open and toasts an error when disconnect fails', async () => {
    listMock.mockResolvedValue({ data: [connected] });
    disconnectMock.mockRejectedValue(new Error('boom'));

    render(<ConnectionsPage />);
    const card = await screen.findByTestId('connection-card-linear');
    fireEvent.click(within(card).getByRole('button', { name: /disconnect/i }));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: /disconnect/i }),
    );

    await waitFor(() => expect(disconnectMock).toHaveBeenCalledWith('linear'));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    // The dialog stays open on failure so the user can retry — not dismissed.
    expect(screen.queryByRole('alertdialog')).not.toBeNull();
  });

  it('shows a retry affordance when the list fails to load, then recovers', async () => {
    listMock.mockRejectedValueOnce(new Error('nope'));

    render(<ConnectionsPage />);

    const errorCard = await screen.findByTestId('connections-load-error');
    expect(
      within(errorCard).getByRole('button', { name: /retry/i }),
    ).toBeTruthy();
    expect(toastErrorMock).toHaveBeenCalled();

    // Retry succeeds → the provider cards render in place of the error card.
    listMock.mockResolvedValueOnce({ data: [connected] });
    fireEvent.click(within(errorCard).getByRole('button', { name: /retry/i }));

    const card = await screen.findByTestId('connection-card-linear');
    expect(
      within(card).getByText(/Authenticated as Acme Workspace/),
    ).toBeTruthy();
    expect(screen.queryByTestId('connections-load-error')).toBeNull();
  });
});
