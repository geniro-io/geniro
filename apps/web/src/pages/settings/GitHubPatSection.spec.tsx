// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getStatus, setPat, deletePat } = vi.hoisted(() => ({
  getStatus: vi.fn(),
  setPat: vi.fn(),
  deletePat: vi.fn(),
}));

vi.mock('../../api', () => ({
  gitAuthApi: { getStatus, setPat, deletePat },
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

  it('shows the precedence hint when the user also has a GitHub App installation', async () => {
    getStatus.mockResolvedValue({ data: CONFIGURED });
    render(<GitHubPatSection enabled hasAppInstallations />);
    expect(
      await screen.findByText(/takes precedence over the GitHub App/i),
    ).toBeInTheDocument();
  });
});
