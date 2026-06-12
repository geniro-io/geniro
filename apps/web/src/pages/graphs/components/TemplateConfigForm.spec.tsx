// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import type { RJSFSchema } from '@rjsf/utils';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TemplateConfigForm } from './TemplateConfigForm';

// The form module imports the REST API clients for the GitHub/secret fields,
// which are never rendered by the plugins schema below — stub them so the test
// pulls in no network/config machinery.
vi.mock('../../../api', () => ({
  gitRepositoriesApi: {},
  secretsApi: {},
}));

// Mirrors the claudeAgent `plugins` field: an array of objects. This is the
// shape that fell through to @rjsf/core's native (invisible-button) editor.
const PLUGINS_SCHEMA: RJSFSchema = {
  type: 'object',
  properties: {
    plugins: {
      type: 'array',
      title: 'Plugins',
      items: {
        type: 'object',
        properties: {
          repoUrl: { type: 'string', title: 'Repository URL' },
          ref: { type: 'string', title: 'Ref' },
        },
        required: ['repoUrl'],
      },
    },
  },
};

// Same shape, flagged read-only via the `x-ui:readonly` extension that
// buildUiSchema maps to `ui:readonly`. Cast because RJSFSchema's literal type
// does not model the project's `x-ui:*` extension keys (read at runtime).
const READONLY_SCHEMA = {
  type: 'object',
  properties: {
    plugins: {
      type: 'array',
      title: 'Plugins',
      'x-ui:readonly': true,
      items: {
        type: 'object',
        properties: {
          repoUrl: { type: 'string', title: 'Repository URL' },
        },
        required: ['repoUrl'],
      },
    },
  },
} as RJSFSchema;

function Harness({
  initial,
  schema = PLUGINS_SCHEMA,
}: {
  initial: Record<string, unknown>;
  schema?: RJSFSchema;
}) {
  const [formData, setFormData] = useState<Record<string, unknown>>(initial);
  return (
    <TemplateConfigForm
      schema={schema}
      formData={formData}
      onChange={(next) => setFormData(next)}
      liteLlmModels={[]}
      litellmModelsLoading={false}
      onOpenExpandedTextarea={() => {}}
      onOpenAiSuggestion={() => {}}
      aiSuggestionEnabled={false}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe('TemplateConfigForm — object-array (plugins) controls', () => {
  it('renders an Add control with an accessible name for an empty object-array', () => {
    // The fix: the add affordance is a real text-labelled Button reachable by
    // role/name, not @rjsf/core's empty `<i class="glyphicon">` (which would
    // have no accessible name and render invisibly without Bootstrap CSS).
    render(<Harness initial={{ plugins: [] }} />);

    const addButton = screen.getByRole('button', { name: /add/i });
    expect(addButton).toBeInTheDocument();
    expect(addButton).toHaveTextContent(/add/i);
  });

  it('adds an object-array row with its nested fields when Add is clicked', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ plugins: [] }} />);

    expect(screen.queryByText('Repository URL')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /add/i }));
    expect(screen.getByText('Repository URL')).toBeInTheDocument();
  });

  it('renders remove + reorder controls (accessible names) for existing rows', () => {
    render(
      <Harness
        initial={{
          plugins: [
            { repoUrl: 'https://github.com/a/b' },
            { repoUrl: 'https://github.com/c/d' },
          ],
        }}
      />,
    );

    expect(
      screen.getAllByRole('button', { name: /remove item/i }),
    ).toHaveLength(2);
    // Two items → move up/down controls are present and accessibly named.
    expect(
      screen.getAllByRole('button', { name: /move up/i }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('button', { name: /move down/i }).length,
    ).toBeGreaterThan(0);
  });

  it('removes a row when its Remove control is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ plugins: [{ repoUrl: 'https://github.com/a/b' }] }}
      />,
    );

    const removeButtons = screen.getAllByRole('button', {
      name: /remove item/i,
    });
    expect(removeButtons).toHaveLength(1);

    await user.click(removeButtons[0]);
    expect(
      screen.queryByRole('button', { name: /remove item/i }),
    ).not.toBeInTheDocument();
  });

  it('reorders rows when Move down is clicked (control is wired, not just visible)', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          plugins: [{ repoUrl: 'first-row' }, { repoUrl: 'second-row' }],
        }}
      />,
    );

    // repoUrl inputs render in row order; row 0 starts as "first-row".
    expect(screen.getAllByRole('textbox')[0]).toHaveValue('first-row');

    // Row 0's Move-down is the enabled one (the last row's is disabled).
    await user.click(screen.getAllByRole('button', { name: /move down/i })[0]);

    // After reordering, "second-row" is now first — proving the control acts,
    // not merely that it is accessibly named.
    expect(screen.getAllByRole('textbox')[0]).toHaveValue('second-row');
  });

  it('disables the row controls for a read-only array', () => {
    render(
      <Harness
        schema={READONLY_SCHEMA}
        initial={{ plugins: [{ repoUrl: 'frozen' }] }}
      />,
    );

    // `x-ui:readonly` flows to the array field's `readonly`, which the custom
    // templates forward to each button's `disabled`.
    expect(screen.getByRole('button', { name: /remove item/i })).toBeDisabled();
  });
});
