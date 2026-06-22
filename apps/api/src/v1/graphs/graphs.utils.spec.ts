import { describe, expect, it, vi } from 'vitest';

import { TemplateRegistry } from '../graph-templates/services/template-registry';
import { type GraphSchemaType, NodeKind } from './graphs.types';
import {
  extractAgentsFromSchema,
  extractNodeDisplayNamesFromMetadata,
  extractTriggerNodesFromSchema,
  withTimeout,
} from './graphs.utils';

const createMockTemplateRegistry = (
  templateMap: Record<string, { kind: NodeKind; name?: string } | undefined>,
): TemplateRegistry => {
  return {
    getTemplate: (id: string) => templateMap[id],
    getTemplatesByKind: (kind: NodeKind) =>
      Object.entries(templateMap)
        .filter(([, t]) => t?.kind === kind)
        .map(([id, t]) => ({ id, kind: t!.kind, name: t!.name ?? id })),
  } as unknown as TemplateRegistry;
};

describe('extractAgentsFromSchema', () => {
  it('should extract agent info from a simple-agent node with name and description', () => {
    const schema: GraphSchemaType = {
      nodes: [
        {
          id: 'agent-1',
          template: 'simple-agent',
          config: { name: 'My Agent', description: 'A helpful agent' },
        },
      ],
      edges: [],
    };

    const registry = createMockTemplateRegistry({
      'simple-agent': { kind: NodeKind.SimpleAgent },
    });

    const agents = extractAgentsFromSchema(schema, registry);

    expect(agents).toEqual([
      {
        nodeId: 'agent-1',
        name: 'My Agent',
        description: 'A helpful agent',
      },
    ]);
  });

  it('should set description to undefined when node has no description', () => {
    const schema: GraphSchemaType = {
      nodes: [
        {
          id: 'agent-1',
          template: 'simple-agent',
          config: { name: 'My Agent' },
        },
      ],
      edges: [],
    };

    const registry = createMockTemplateRegistry({
      'simple-agent': { kind: NodeKind.SimpleAgent },
    });

    const agents = extractAgentsFromSchema(schema, registry);

    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe('My Agent');
    expect(agents[0]!.description).toBeUndefined();
  });

  it('should exclude non-agent nodes from results', () => {
    const schema: GraphSchemaType = {
      nodes: [
        {
          id: 'trigger-1',
          template: 'manual-trigger',
          config: {},
        },
      ],
      edges: [],
    };

    const registry = createMockTemplateRegistry({
      'manual-trigger': { kind: NodeKind.Trigger },
    });

    const agents = extractAgentsFromSchema(schema, registry);

    expect(agents).toEqual([]);
  });

  it('should exclude nodes whose template is unregistered', () => {
    const schema: GraphSchemaType = {
      nodes: [
        {
          id: 'node-1',
          template: 'unknown-template',
          config: { name: 'Ghost Agent' },
        },
      ],
      edges: [],
    };

    const registry = createMockTemplateRegistry({
      'unknown-template': undefined,
    });

    const agents = extractAgentsFromSchema(schema, registry);

    expect(agents).toEqual([]);
  });

  it('should return empty array for schema with no nodes', () => {
    const schema: GraphSchemaType = {
      nodes: [],
      edges: [],
    };

    const registry = createMockTemplateRegistry({});

    const agents = extractAgentsFromSchema(schema, registry);

    expect(agents).toEqual([]);
  });

  it('should fall back to template name when config has no name', () => {
    const schema: GraphSchemaType = {
      nodes: [
        {
          id: 'agent-1',
          template: 'simple-agent',
          config: {},
        },
      ],
      edges: [],
    };

    const registry = createMockTemplateRegistry({
      'simple-agent': { kind: NodeKind.SimpleAgent },
    });

    const agents = extractAgentsFromSchema(schema, registry);

    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe('simple-agent');
    expect(agents[0]!.description).toBeUndefined();
  });

  it('should extract multiple agents from schema with mixed node types', () => {
    const schema: GraphSchemaType = {
      nodes: [
        {
          id: 'agent-1',
          template: 'simple-agent',
          config: { name: 'Agent Alpha', description: 'First agent' },
        },
        {
          id: 'trigger-1',
          template: 'manual-trigger',
          config: {},
        },
        {
          id: 'agent-2',
          template: 'simple-agent',
          config: { name: 'Agent Beta' },
        },
      ],
      edges: [],
    };

    const registry = createMockTemplateRegistry({
      'simple-agent': { kind: NodeKind.SimpleAgent },
      'manual-trigger': { kind: NodeKind.Trigger },
    });

    const agents = extractAgentsFromSchema(schema, registry);

    expect(agents).toHaveLength(2);
    expect(agents[0]).toEqual({
      nodeId: 'agent-1',
      name: 'Agent Alpha',
      description: 'First agent',
    });
    expect(agents[1]).toEqual({
      nodeId: 'agent-2',
      name: 'Agent Beta',
      description: undefined,
    });
  });
});

describe('extractTriggerNodesFromSchema', () => {
  it('should extract trigger nodes from schema', () => {
    const schema: GraphSchemaType = {
      nodes: [
        { id: 'trigger-1', template: 'manual-trigger', config: {} },
        { id: 'agent-1', template: 'simple-agent', config: {} },
      ],
      edges: [],
    };
    const registry = createMockTemplateRegistry({
      'manual-trigger': { kind: NodeKind.Trigger, name: 'Manual Trigger' },
      'simple-agent': { kind: NodeKind.SimpleAgent },
    });

    const triggers = extractTriggerNodesFromSchema(schema, null, registry);

    expect(triggers).toEqual([
      { id: 'trigger-1', name: 'Manual Trigger', template: 'manual-trigger' },
    ]);
  });

  it('should use metadata display name when available', () => {
    const schema: GraphSchemaType = {
      nodes: [{ id: 'trigger-1', template: 'manual-trigger', config: {} }],
      edges: [],
    };
    const metadata = {
      nodes: [{ id: 'trigger-1', name: 'My Custom Trigger' }],
    };
    const registry = createMockTemplateRegistry({
      'manual-trigger': { kind: NodeKind.Trigger, name: 'Manual Trigger' },
    });

    const triggers = extractTriggerNodesFromSchema(schema, metadata, registry);

    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.name).toBe('My Custom Trigger');
  });

  it('should fall back to template name when metadata has no name', () => {
    const schema: GraphSchemaType = {
      nodes: [{ id: 'trigger-1', template: 'manual-trigger', config: {} }],
      edges: [],
    };
    const metadata = {
      nodes: [{ id: 'trigger-1' }],
    };
    const registry = createMockTemplateRegistry({
      'manual-trigger': { kind: NodeKind.Trigger, name: 'Manual Trigger' },
    });

    const triggers = extractTriggerNodesFromSchema(schema, metadata, registry);

    expect(triggers[0]!.name).toBe('Manual Trigger');
  });

  it('should return empty array when no trigger nodes exist', () => {
    const schema: GraphSchemaType = {
      nodes: [{ id: 'agent-1', template: 'simple-agent', config: {} }],
      edges: [],
    };
    const registry = createMockTemplateRegistry({
      'simple-agent': { kind: NodeKind.SimpleAgent },
    });

    const triggers = extractTriggerNodesFromSchema(schema, null, registry);

    expect(triggers).toEqual([]);
  });

  it('should handle multiple trigger nodes', () => {
    const schema: GraphSchemaType = {
      nodes: [
        { id: 'trigger-1', template: 'manual-trigger', config: {} },
        { id: 'trigger-2', template: 'webhook-trigger', config: {} },
      ],
      edges: [],
    };
    const registry = createMockTemplateRegistry({
      'manual-trigger': { kind: NodeKind.Trigger, name: 'Manual Trigger' },
      'webhook-trigger': { kind: NodeKind.Trigger, name: 'Webhook Trigger' },
    });

    const triggers = extractTriggerNodesFromSchema(schema, null, registry);

    expect(triggers).toHaveLength(2);
    expect(triggers[0]!.template).toBe('manual-trigger');
    expect(triggers[1]!.template).toBe('webhook-trigger');
  });
});

describe('extractNodeDisplayNamesFromMetadata', () => {
  it('should extract display names from metadata nodes', () => {
    const metadata = {
      nodes: [
        { id: 'node-1', name: 'My Node' },
        { id: 'node-2', name: 'Another Node' },
      ],
    };

    const names = extractNodeDisplayNamesFromMetadata(metadata);

    expect(names).toEqual({
      'node-1': 'My Node',
      'node-2': 'Another Node',
    });
  });

  it('should skip nodes without names', () => {
    const metadata = {
      nodes: [
        { id: 'node-1', name: 'Named Node' },
        { id: 'node-2' },
        { id: 'node-3', name: '' },
      ],
    };

    const names = extractNodeDisplayNamesFromMetadata(metadata);

    expect(names).toEqual({
      'node-1': 'Named Node',
    });
  });

  it('should return empty object for null metadata', () => {
    expect(extractNodeDisplayNamesFromMetadata(null)).toEqual({});
  });

  it('should return empty object for undefined metadata', () => {
    expect(extractNodeDisplayNamesFromMetadata(undefined)).toEqual({});
  });

  it('should return empty object when metadata has no nodes array', () => {
    expect(extractNodeDisplayNamesFromMetadata({ zoom: 1 })).toEqual({});
  });

  it('should trim whitespace from names and skip whitespace-only names', () => {
    const metadata = {
      nodes: [
        { id: 'node-1', name: '  Trimmed  ' },
        { id: 'node-2', name: '   ' },
      ],
    };

    const names = extractNodeDisplayNamesFromMetadata(metadata);

    expect(names).toEqual({
      'node-1': 'Trimmed',
    });
  });
});

describe('withTimeout', () => {
  it('resolves with the value when the promise settles before the timeout', async () => {
    await expect(
      withTimeout(Promise.resolve('ok'), 1_000, 'too slow'),
    ).resolves.toBe('ok');
  });

  it('rejects with the timeout message when the promise does not settle in time', async () => {
    vi.useFakeTimers();
    try {
      const pending = new Promise<string>(() => {});
      const raced = withTimeout(pending, 5_000, 'compilation timed out');
      const settled = expect(raced).rejects.toThrow('compilation timed out');
      await vi.advanceTimersByTimeAsync(5_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the timer when the promise wins (no late rejection past the deadline)', async () => {
    vi.useFakeTimers();
    try {
      await expect(
        withTimeout(Promise.resolve('done'), 5_000, 'too slow'),
      ).resolves.toBe('done');
      // Advancing past the deadline must NOT surface a late/unhandled rejection.
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
