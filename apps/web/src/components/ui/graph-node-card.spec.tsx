// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { GraphNodeCard } from './graph-node-card';

afterEach(cleanup);

describe('GraphNodeCard metadata chips', () => {
  it('renders a string property as a "title: value" chip', () => {
    render(
      <GraphNodeCard
        label="Claude agent"
        metadataProperties={[
          { key: 'model', value: 'claude-opus-4-8', title: 'Model' },
        ]}
      />,
    );

    expect(screen.getByText('Model: claude-opus-4-8')).toBeInTheDocument();
  });

  it('renders a boolean "on" toggle (empty value) as a bare flag chip — title only', () => {
    render(
      <GraphNodeCard
        label="Claude agent"
        metadataProperties={[
          { key: 'context', value: '', title: '1M context' },
        ]}
      />,
    );

    expect(screen.getByText('1M context')).toBeInTheDocument();
    // No dangling "1M context:" — the flag chip carries the title alone.
    expect(screen.queryByText(/1M context:/)).not.toBeInTheDocument();
  });

  it('renders effort and 1M-context chips together (Claude node shape)', () => {
    render(
      <GraphNodeCard
        label="Claude agent"
        metadataProperties={[
          { key: 'model', value: 'claude-opus-4-8', title: 'Model' },
          { key: 'effort', value: 'high', title: 'Effort' },
          { key: 'context', value: '', title: '1M context' },
        ]}
      />,
    );

    expect(screen.getByText('Effort: high')).toBeInTheDocument();
    expect(screen.getByText('1M context')).toBeInTheDocument();
  });
});
