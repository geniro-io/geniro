// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getStatus, setPat, deletePat, syncRepositories } = vi.hoisted(() => ({
  getStatus: vi.fn(),
  setPat: vi.fn(),
  deletePat: vi.fn(),
  syncRepositories: vi.fn(),
}));

vi.mock('../../api', () => ({
  gitAuthApi: { getStatus, setPat, deletePat },
  gitRepositoriesApi: { syncRepositories },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { GitHubPatSection } from './GitHubPatSection';

const NO_PAT = {
  configured: false,
  login: null,
  tokenType: null,
  validatedAt: null,
};

const CONFIGURED = {
  configured: true,
  login: 'octocat',
  tokenType: 'fine-grained' as const,
  validatedAt: '2026-01-01T00:00:00.000Z',
};

describe('GitHubPatSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStatus.mockResolvedValue({ data: NO_PAT });
    setPat.mockResolvedValue({
      data: {
        configured: true,
        login: 'octocat',
        tokenType: 'classic',
        validatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    deletePat.mockResolvedValue({});
    syncRepositories.mockResolvedValue({
      data: { synced: 3, removed: 1, total: 12 },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a degraded note and does not fetch when the secrets store is unavailable', () => {
    render(<GitHubPatSection enabled={false} hasAppInstallations={false} />);
    expect(
      screen.getByText(/require a configured secrets store/i),
    ).toBeInTheDocument();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('renders the token input (state A) when no PAT is configured', async () => {
    render(<GitHubPatSection enabled hasAppInstallations={false} />);
    expect(await screen.findByLabelText('Token')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('renders the connected account (state B) when a PAT is configured', async () => {
    getStatus.mockResolvedValue({ data: CONFIGURED });
    render(<GitHubPatSection enabled hasAppInstallations={false} />);
    expect(await screen.findByText(/Connected as/)).toBeInTheDocument();
    expect(screen.getByText('octocat')).toBeInTheDocument();
    expect(screen.getByText('Fine-grained')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('saves a token (validate-on-save) and flips to the connected state', async () => {
    const user = userEvent.setup();
    render(<GitHubPatSection enabled hasAppInstallations={false} />);
    const input = await screen.findByLabelText('Token');
    await user.type(input, 'ghp_token');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(setPat).toHaveBeenCalledWith({ token: 'ghp_token' }),
    );
    expect(await screen.findByText(/Connected as/)).toBeInTheDocument();
  });

  it('stays in the input state and surfaces an error when validate-on-save fails', async () => {
    setPat.mockRejectedValue(new Error('bad token'));
    const user = userEvent.setup();
    render(<GitHubPatSection enabled hasAppInstallations={false} />);
    const input = await screen.findByLabelText('Token');
    await user.type(input, 'ghp_bad');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setPat).toHaveBeenCalled());
    // Still on the input form (no flip to connected state).
    expect(screen.getByLabelText('Token')).toBeInTheDocument();
    expect(screen.queryByText(/Connected as/)).not.toBeInTheDocument();
  });

  it('syncs repositories via the PAT and reports the count in a toast (not a silent no-op)', async () => {
    getStatus.mockResolvedValue({ data: CONFIGURED });
    const user = userEvent.setup();
    render(<GitHubPatSection enabled hasAppInstallations={false} />);

    await user.click(
      await screen.findByRole('button', { name: /Sync repositories/i }),
    );
    await waitFor(() => expect(syncRepositories).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('3 added'),
    );
  });

  it('links to the Repositories page (where PAT repos appear) when a project href is provided', async () => {
    getStatus.mockResolvedValue({ data: CONFIGURED });
    render(
      <MemoryRouter>
        <GitHubPatSection
          enabled
          hasAppInstallations={false}
          repositoriesHref="/projects/p1/repositories"
        />
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', {
      name: /Repositories page/i,
    });
    expect(link).toHaveAttribute('href', '/projects/p1/repositories');
  });

  it('shows the precedence hint when the user also has a GitHub App installation', async () => {
    getStatus.mockResolvedValue({ data: CONFIGURED });
    render(<GitHubPatSection enabled hasAppInstallations />);
    expect(
      await screen.findByText(/takes precedence over the GitHub App/i),
    ).toBeInTheDocument();
  });

  it('removes the token through a confirmation dialog and flips back to the input state', async () => {
    getStatus.mockResolvedValue({ data: CONFIGURED });
    const user = userEvent.setup();
    render(<GitHubPatSection enabled hasAppInstallations={false} />);
    expect(await screen.findByText(/Connected as/)).toBeInTheDocument();

    // Clicking Remove only OPENS the confirm dialog — it must not delete yet.
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(deletePat).not.toHaveBeenCalled();

    // Confirming in the dialog performs the delete and flips to state A.
    await user.click(
      await screen.findByRole('button', { name: 'Remove token' }),
    );
    await waitFor(() => expect(deletePat).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText('Token')).toBeInTheDocument();
    expect(screen.queryByText(/Connected as/)).not.toBeInTheDocument();
  });

  it('keeps the connected state and surfaces an error when the remove fails', async () => {
    getStatus.mockResolvedValue({ data: CONFIGURED });
    deletePat.mockRejectedValue(new Error('cannot remove'));
    const user = userEvent.setup();
    render(<GitHubPatSection enabled hasAppInstallations={false} />);
    expect(await screen.findByText(/Connected as/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(
      await screen.findByRole('button', { name: 'Remove token' }),
    );
    await waitFor(() => expect(deletePat).toHaveBeenCalled());

    // The error surfaces and the card stays in the connected state (no flip).
    expect(
      await screen.findByText(/Failed to remove the token/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Connected as/)).toBeInTheDocument();
  });

  it('shows an error + Retry (not the empty add-token form) when the status fetch fails, and recovers on Retry', async () => {
    // A failed status fetch must NOT silently drop to state A (which implies no
    // token exists). It surfaces an error with a Retry that refetches.
    getStatus.mockReset();
    getStatus
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ data: NO_PAT });
    const user = userEvent.setup();
    render(<GitHubPatSection enabled hasAppInstallations={false} />);

    expect(
      await screen.findByText(/Could not load your GitHub token status/i),
    ).toBeInTheDocument();
    // The empty add-token form must NOT be shown in the error state.
    expect(screen.queryByLabelText('Token')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    // Recovered: the error clears and the (NO_PAT) input form renders.
    expect(await screen.findByLabelText('Token')).toBeInTheDocument();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });
});
