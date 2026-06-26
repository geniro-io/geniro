// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const {
  listMemoryNamespaces,
  listMemoryEntries,
  saveMemoryEntry,
  deleteMemoryEntry,
} = vi.hoisted(() => ({
  listMemoryNamespaces: vi.fn(),
  listMemoryEntries: vi.fn(),
  saveMemoryEntry: vi.fn(),
  deleteMemoryEntry: vi.fn(),
}));

vi.mock('../../api', () => ({
  agentMemoryApi: {
    listMemoryNamespaces,
    listMemoryEntries,
    saveMemoryEntry,
    deleteMemoryEntry,
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
  beforeAll(() => {
    // jsdom doesn't implement these; Radix Select calls them when the dropdown
    // opens. Without the polyfills userEvent can't open the namespace selector.
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    if (!('ResizeObserver' in globalThis)) {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    }
  });

  beforeEach(() => {
    listMemoryNamespaces.mockReset();
    listMemoryEntries.mockReset();
    saveMemoryEntry.mockReset();
    deleteMemoryEntry.mockReset();
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

  it('ignores a stale namespace response after the user switches namespaces', async () => {
    const factsEntry = {
      ...entry,
      id: 'f1',
      namespace: 'facts',
      key: 'facts-key',
      title: 'Facts entry',
    };
    const plansEntry = {
      ...entry,
      id: 'p1',
      namespace: 'plans',
      key: 'plans-key',
      title: 'Plans entry',
    };

    listMemoryNamespaces.mockResolvedValue({
      data: [
        {
          namespace: 'facts',
          mode: 'kv',
          entryCount: 1,
          lastUpdatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          namespace: 'plans',
          mode: 'kv',
          entryCount: 1,
          lastUpdatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    // Per-namespace deferred promises so the test controls resolution order.
    let resolveFacts!: (v: { data: unknown }) => void;
    let resolvePlans!: (v: { data: unknown }) => void;
    const factsResponse = new Promise<{ data: unknown }>((r) => {
      resolveFacts = r;
    });
    const plansResponse = new Promise<{ data: unknown }>((r) => {
      resolvePlans = r;
    });
    listMemoryEntries.mockImplementation((ns: string) =>
      ns === 'facts' ? factsResponse : plansResponse,
    );

    const user = userEvent.setup();
    renderPage();

    // 'facts' auto-selects on load → loadEntries('facts') is in-flight.
    await waitFor(() =>
      expect(listMemoryEntries).toHaveBeenCalledWith('facts'),
    );

    // Switch to 'plans' — loadEntries('plans') now in-flight too; the guard ref
    // advances to 'plans'.
    await user.click(await screen.findByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /plans/i }));
    await waitFor(() =>
      expect(listMemoryEntries).toHaveBeenCalledWith('plans'),
    );

    // Resolve the CURRENT namespace first; its entries render.
    resolvePlans({ data: [plansEntry] });
    expect(await screen.findByText('Plans entry')).toBeInTheDocument();

    // Now resolve the STALE 'facts' load last. The guard must drop it so it
    // never overwrites the current namespace's table.
    resolveFacts({ data: [factsEntry] });
    await waitFor(() => expect(listMemoryEntries).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Facts entry')).not.toBeInTheDocument();
    expect(screen.getByText('Plans entry')).toBeInTheDocument();
  });

  it('deletes through the AlertDialog confirm, not a native prompt', async () => {
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
    deleteMemoryEntry.mockResolvedValue({ data: undefined });

    const user = userEvent.setup();
    renderPage();

    await waitFor(() =>
      expect(screen.getByText('Package manager')).toBeInTheDocument(),
    );

    // Clicking the row delete opens the AlertDialog — no API call yet, and no
    // native window.confirm (which jsdom would leave unhandled).
    await user.click(screen.getByRole('button', { name: 'Delete memory' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(deleteMemoryEntry).not.toHaveBeenCalled();

    // Confirming in the dialog issues the delete with the entry's namespace/key.
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(deleteMemoryEntry).toHaveBeenCalledWith('facts', 'pm'),
    );
  });
});
