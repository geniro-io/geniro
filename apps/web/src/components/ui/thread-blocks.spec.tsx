// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ── Module mocks for heavy/non-essential deps ─────────────────────────────────

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../markdown/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => (
    <div data-testid="markdown-content">{content}</div>
  ),
}));

vi.mock('./syntax-highlighter', () => ({
  SyntaxHighlighter: ({ children }: { children: React.ReactNode }) => (
    <code>{children}</code>
  ),
}));

vi.mock('./json-view', () => ({
  JsonViewer: () => <div data-testid="json-viewer" />,
}));

vi.mock('./agent-avatar', () => ({
  AgentAvatar: () => <div data-testid="agent-avatar" />,
  getAgentInitials: (name: string) => name.slice(0, 2).toUpperCase(),
}));

vi.mock('ansi_up', () => ({
  AnsiUp: class {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- mocking external library API shape (real ansi_up uses snake_case method names)
    ansi_to_html(text: string) {
      return text;
    }
  },
}));

vi.mock('dompurify', () => ({
  default: { sanitize: (html: string) => html },
}));

import React from 'react';

import {
  CommunicationBlock,
  formatToolName,
  ReasoningBlock,
  StatFooter,
  SubagentBlock,
  ToolBlock,
  WorkingBlock,
} from './thread-blocks';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Produces a content string longer than the 130-char isLong threshold. */
const LONG_CONTENT =
  'This is a very detailed piece of reasoning that goes on for quite a long time and exceeds one hundred and thirty characters easily.';

/** Short content — stays under 130 chars. */
const SHORT_CONTENT = 'Brief reasoning.';

// ── Shared teardown ────────────────────────────────────────────────────────────

// Ensure each test starts with a clean DOM, regardless of auto-cleanup timing.
afterEach(() => {
  cleanup();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ReasoningBlock — streaming branch', () => {
  // ── Test 1: streaming + long content, default (collapsed) ─────────────────

  it('renders clamp container + "Show more" button when streaming with long content (collapsed by default)', () => {
    const { container } = render(
      <ReasoningBlock content={LONG_CONTENT} isStreaming />,
    );

    // Clamp container must be present within this render's container
    const clampContainer = container.querySelector(
      '.overflow-hidden.max-h-\\[2lh\\]',
    );
    expect(clampContainer).not.toBeNull();

    // The paragraph with content must be inside the clamp container
    const paragraph = clampContainer?.querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(paragraph?.textContent).toBe(LONG_CONTENT);

    // Show more button must be present
    const showMoreBtn = screen.getByRole('button', { name: /show more/i });
    expect(showMoreBtn).toBeInTheDocument();

    // "reasoning…" label must be visible
    expect(screen.getByText('reasoning…')).toBeInTheDocument();
  });

  // ── Test 2: clicking "Show more" expands content ──────────────────────────

  it('expands content and shows "Show less" after clicking "Show more"', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ReasoningBlock content={LONG_CONTENT} isStreaming />,
    );

    const showMoreBtn = screen.getByRole('button', { name: /show more/i });
    await user.click(showMoreBtn);

    // Clamp container must be gone after expand
    const clampContainer = container.querySelector(
      '.overflow-hidden.max-h-\\[2lh\\]',
    );
    expect(clampContainer).toBeNull();

    // The paragraph must be rendered directly (not inside a clamp wrapper)
    const paragraphs = container.querySelectorAll('p');
    const contentParagraph = Array.from(paragraphs).find(
      (p) => p.textContent === LONG_CONTENT,
    );
    expect(contentParagraph).not.toBeNull();

    // Button must now say "Show less"
    expect(
      screen.getByRole('button', { name: /show less/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull();
  });

  // ── Test 3: tail auto-scroll — containerRef.scrollTop === scrollHeight ────

  it('pins scrollTop to scrollHeight of the clamp container (tail auto-scroll)', () => {
    // Stub scrollHeight on HTMLElement.prototype so it returns 100.
    // This must be done before render so the element inherits the override
    // when useLayoutEffect fires (synchronously in act).
    const STUBBED_HEIGHT = 100;
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => STUBBED_HEIGHT,
    });

    let container!: HTMLElement;
    try {
      act(() => {
        ({ container } = render(
          <ReasoningBlock content={LONG_CONTENT} isStreaming />,
        ));
      });

      const clampContainer = container.querySelector(
        '.overflow-hidden.max-h-\\[2lh\\]',
      ) as HTMLElement | null;
      expect(clampContainer).not.toBeNull();

      // useLayoutEffect must have set scrollTop = scrollHeight (= STUBBED_HEIGHT).
      // Verify by reading scrollTop directly off the element.
      expect(clampContainer!.scrollTop).toBe(STUBBED_HEIGHT);
    } finally {
      // Restore original descriptor regardless of test outcome.
      if (originalDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          'scrollHeight',
          originalDescriptor,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
      }
    }
  });

  // ── Test 4: streaming + short content — no clamp, no Show more ───────────

  it('does not render clamp container or "Show more" button for short content', () => {
    const { container } = render(
      <ReasoningBlock content={SHORT_CONTENT} isStreaming />,
    );

    // No clamp container
    const clampContainer = container.querySelector(
      '.overflow-hidden.max-h-\\[2lh\\]',
    );
    expect(clampContainer).toBeNull();

    // No Show more button
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull();

    // Content paragraph rendered directly
    const paragraphs = container.querySelectorAll('p');
    const contentParagraph = Array.from(paragraphs).find(
      (p) => p.textContent === SHORT_CONTENT,
    );
    expect(contentParagraph).not.toBeNull();

    // "reasoning…" label still present
    expect(screen.getByText('reasoning…')).toBeInTheDocument();
  });
});

// ── Test 5: non-streaming + long content — existing behavior preserved ────────

describe('ReasoningBlock — non-streaming branch (smoke test)', () => {
  it('applies line-clamp-2 on long content and allows expansion via Show more', async () => {
    const user = userEvent.setup();
    const { container } = render(<ReasoningBlock content={LONG_CONTENT} />);

    // In the non-streaming path, the paragraph carries line-clamp-2 while collapsed
    const clampedParagraph = container.querySelector('p.line-clamp-2');
    expect(clampedParagraph).not.toBeNull();
    expect(clampedParagraph?.textContent).toBe(LONG_CONTENT);

    // Show more button exists
    const showMoreBtn = screen.getByRole('button', { name: /show more/i });
    expect(showMoreBtn).toBeInTheDocument();

    // Click expands — line-clamp-2 must be removed
    await user.click(showMoreBtn);
    const stillClamped = container.querySelector('p.line-clamp-2');
    expect(stillClamped).toBeNull();

    // Button switches to Show less
    expect(
      screen.getByRole('button', { name: /show less/i }),
    ).toBeInTheDocument();
  });
});

// ── SubagentBlock footer token source tests ────────────────────────────────────

describe('SubagentBlock — footer tokens source', () => {
  it('displays statistics totals in footer when statistics is set', () => {
    const { container } = render(
      <SubagentBlock
        status="done"
        statistics={{
          usage: { totalTokens: 12345, totalPrice: 0.053 },
        }}>
        <div>child</div>
      </SubagentBlock>,
    );

    const badge = container.querySelector('[class*="cursor-pointer"]');
    expect(badge).not.toBeNull();
    const badgeText = badge?.textContent ?? '';
    expect(badgeText).toContain('12.3K');
  });

  it('renders genuine 0 totals as "0 ($0.000)" rather than hiding the badge', () => {
    const { container } = render(
      <SubagentBlock
        status="running"
        statistics={{
          usage: { totalTokens: 0, totalPrice: 0 },
        }}>
        <div>child</div>
      </SubagentBlock>,
    );

    const badge = container.querySelector('[class*="cursor-pointer"]');
    expect(badge).not.toBeNull();
    const badgeText = badge?.textContent ?? '';
    expect(badgeText).toContain('0');
    expect(badgeText).toContain('$0.000');
  });

  it('renders no token badge when statistics is absent', () => {
    const { container } = render(
      <SubagentBlock status="done">
        <div>child</div>
      </SubagentBlock>,
    );

    const badge = container.querySelector('[class*="cursor-pointer"]');
    expect(badge).toBeNull();
  });
});

describe('formatToolName', () => {
  it('prettifies an MCP tool identifier into "Server: Tool name"', () => {
    expect(formatToolName('mcp__linear__get_issue')).toBe('Linear: Get issue');
  });

  it('handles multi-word tool segments', () => {
    expect(formatToolName('mcp__google_drive__search_files')).toBe(
      'Google_drive: Search files',
    );
  });

  it('returns non-MCP tool names unchanged', () => {
    expect(formatToolName('read_file')).toBe('read_file');
    expect(formatToolName('finish')).toBe('finish');
    expect(formatToolName('gh_clone')).toBe('gh_clone');
  });
});

describe('ToolBlock — MCP name rendering', () => {
  it('shows the prettified MCP name, not the raw identifier', () => {
    render(<ToolBlock toolName="mcp__linear__get_issue" status="done" />);
    expect(screen.getByText('Linear: Get issue')).toBeInTheDocument();
    expect(
      screen.queryByText('mcp__linear__get_issue'),
    ).not.toBeInTheDocument();
  });
});

describe('WorkingBlock', () => {
  it('shows the summary and hides children by default (collapsed)', () => {
    render(
      <WorkingBlock summary="Read 2 files">
        <div>tool-chip</div>
      </WorkingBlock>,
    );
    expect(screen.getByText('Read 2 files')).toBeInTheDocument();
    expect(screen.queryByText('tool-chip')).not.toBeInTheDocument();
  });

  it('reveals children when the summary header is clicked', async () => {
    const user = userEvent.setup();
    render(
      <WorkingBlock summary="Read 2 files">
        <div>tool-chip</div>
      </WorkingBlock>,
    );
    await user.click(screen.getByRole('button', { name: /read 2 files/i }));
    expect(screen.getByText('tool-chip')).toBeInTheDocument();
  });

  it('respects defaultOpen', () => {
    render(
      <WorkingBlock summary="Read 2 files" defaultOpen>
        <div>tool-chip</div>
      </WorkingBlock>,
    );
    expect(screen.getByText('tool-chip')).toBeInTheDocument();
  });
});

// ── CommunicationBlock — new-thread / continued session badge ──────────────────

describe('CommunicationBlock — session badge', () => {
  it('renders a "new thread · <label>" badge for a fresh sub-thread', () => {
    render(
      <CommunicationBlock
        status="done"
        targetAgentName="Engineer"
        sessionLabel="plan"
        isNewThread>
        <div />
      </CommunicationBlock>,
    );
    expect(screen.getByText(/new thread · plan/)).toBeInTheDocument();
  });

  it('renders a "continued · <label>" badge for a resumed sub-thread', () => {
    render(
      <CommunicationBlock
        status="done"
        targetAgentName="Engineer"
        sessionLabel="implement"
        isNewThread={false}>
        <div />
      </CommunicationBlock>,
    );
    expect(screen.getByText(/continued · implement/)).toBeInTheDocument();
  });

  it('renders no session badge when neither label nor new-thread flag is set', () => {
    render(
      <CommunicationBlock status="done" targetAgentName="Engineer">
        <div />
      </CommunicationBlock>,
    );
    expect(screen.queryByText(/new thread|continued/)).toBeNull();
  });
});
