// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphCard } from './graph-card';

afterEach(cleanup);

describe('GraphCard run/stop button', () => {
  it('shows "Run" with an enabled button for a stopped graph', () => {
    render(<GraphCard name="G" status="stopped" onToggleRun={() => {}} />);
    const button = screen.getByRole('button', { name: /run/i });
    expect(button).toBeEnabled();
  });

  it('shows "Stop" for a running graph', () => {
    render(<GraphCard name="G" status="running" onToggleRun={() => {}} />);
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });

  it('shows an enabled "Stop" (cancel) for a compiling graph, not a "Run"', () => {
    // 'compiling' is active in the backend registry — a "Run" would error with
    // GRAPH_ALREADY_RUNNING, so the toggle must offer to cancel via destroy.
    render(<GraphCard name="G" status="compiling" onToggleRun={() => {}} />);
    const stop = screen.getByRole('button', { name: /stop/i });
    expect(stop).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: /run/i }),
    ).not.toBeInTheDocument();
  });

  it('disables the toggle button while a toggle is in flight', () => {
    render(
      <GraphCard name="G" status="stopped" isToggling onToggleRun={() => {}} />,
    );
    expect(screen.getByRole('button', { name: /run/i })).toBeDisabled();
  });

  it('does not fire onToggleRun while toggling', async () => {
    const onToggleRun = vi.fn();
    render(
      <GraphCard
        name="G"
        status="stopped"
        isToggling
        onToggleRun={onToggleRun}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /run/i }));
    expect(onToggleRun).not.toHaveBeenCalled();
  });

  it('fires onToggleRun on click when not toggling', async () => {
    const onToggleRun = vi.fn();
    render(<GraphCard name="G" status="stopped" onToggleRun={onToggleRun} />);
    await userEvent.click(screen.getByRole('button', { name: /run/i }));
    expect(onToggleRun).toHaveBeenCalledTimes(1);
  });

  it('does not trigger card onClick when the toggle button is clicked', async () => {
    const onClick = vi.fn();
    const onToggleRun = vi.fn();
    render(
      <GraphCard
        name="G"
        status="stopped"
        onClick={onClick}
        onToggleRun={onToggleRun}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /run/i }));
    expect(onToggleRun).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});
