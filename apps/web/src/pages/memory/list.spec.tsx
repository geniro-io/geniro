// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listMemoryNamespaces, listMemoryEntries, saveMemoryEntry } = vi.hoisted(
  () => ({
    listMemoryNamespaces: vi.fn(),
    listMemoryEntries: vi.fn(),
    saveMemoryEntry: vi.fn(),
  }),
);

vi.mock('../../api', () => ({
  agentMemoryApi: {
    listMemoryNamespaces,
    listMemoryEntries,
    saveMemoryEntry,
    deleteMemoryEntry: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { MemoryRouter, Route, Routes } from 'react-router';

import { MemoryListPage } from './list';

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/projects/p1/memory']}>
      <Routes>
        <Route
          path="/projects/:projectId/memory"
          element={<MemoryListPage />}
        />
      </Routes>
    </MemoryRouter>,
  );

const entry = {
  id: 'e1',
  projectId: 'p1',
  namespace: 'facts',
  key: 'pm',
  title: 'Package manager',
  value: 'pnpm, not npm',
  mode: 'kv' as const,
  authorAgentId: 'Engineer',
  tags: ['build'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('MemoryListPage', () => {
  beforeEach(() => {
    listMemoryNamespaces.mockReset();
    listMemoryEntries.mockReset();
    saveMemoryEntry.mockReset();
  });

  afterEach(() => cleanup());

  it('renders entries from the first namespace', async () => {
    listMemoryNamespaces.mockResolvedValue({
      data: [
        {
          namespace: 'facts',
          mode: 'kv',
          entryCount: 1,
          lastUpdatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    listMemoryEntries.mockResolvedValue({ data: [entry] });

    renderPage();

    await waitFor(() =>
      expect(screen.getByText('Package manager')).toBeInTheDocument(),
    );
    expect(screen.getByText('pm')).toBeInTheDocument();
    expect(screen.getByText('build')).toBeInTheDocument();
    expect(listMemoryEntries).toHaveBeenCalledWith('facts');
  });

  it('shows an empty state when the project has no memory', async () => {
    listMemoryNamespaces.mockResolvedValue({ data: [] });

    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/No memories yet/i)).toBeInTheDocument(),
    );
    expect(listMemoryEntries).not.toHaveBeenCalled();
  });

  it('opens the create dialog from the New memory button', async () => {
    listMemoryNamespaces.mockResolvedValue({
      data: [
        {
          namespace: 'facts',
          mode: 'kv',
          entryCount: 1,
          lastUpdatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    listMemoryEntries.mockResolvedValue({ data: [entry] });

    renderPage();

    await waitFor(() =>
      expect(screen.getByText('Package manager')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /New memory/i }));

    expect(
      screen.getByRole('heading', { name: 'New memory' }),
    ).toBeInTheDocument();
    // The dialog form fields carry unique placeholders (the selector also has a
    // "Namespace" label, so query by placeholder to stay unambiguous).
    expect(screen.getByPlaceholderText('conventions')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('package-manager')).toBeInTheDocument();
  });

  it('saves a new memory from the dialog with the entered values', async () => {
    listMemoryNamespaces.mockResolvedValue({
      data: [
        {
          namespace: 'facts',
          mode: 'kv',
          entryCount: 1,
          lastUpdatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    listMemoryEntries.mockResolvedValue({ data: [entry] });
    saveMemoryEntry.mockResolvedValue({ data: entry });

    renderPage();

    await waitFor(() =>
      expect(screen.getByText('Package manager')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /New memory/i }));
    fireEvent.change(screen.getByPlaceholderText('conventions'), {
      target: { value: 'facts' },
    });
    fireEvent.change(screen.getByPlaceholderText('package-manager'), {
      target: { value: 'pm' },
    });
    fireEvent.change(screen.getByPlaceholderText('Text or JSON'), {
      target: { value: 'pnpm, not npm' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(saveMemoryEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'facts',
          key: 'pm',
          value: 'pnpm, not npm',
        }),
      ),
    );
  });
});
