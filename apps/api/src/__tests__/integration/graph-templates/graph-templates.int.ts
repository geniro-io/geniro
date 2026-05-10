import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TemplateDto,
  TemplateSchema,
} from '../../../v1/graph-templates/dto/templates.dto';
import { TemplateRegistry } from '../../../v1/graph-templates/services/template-registry';
import { TemplatesService } from '../../../v1/graph-templates/services/templates.service';
import { NodeKind } from '../../../v1/graphs/graphs.types';
import { createTestModule } from '../setup';

type TemplateConnection = NonNullable<TemplateDto['inputs']>[number];

describe('Graph Templates Integration Tests', () => {
  let app: INestApplication;
  let templatesService: TemplatesService;
  let templateRegistry: TemplateRegistry;

  const expectValidConnection = (connection: TemplateConnection) => {
    expect(['kind', 'template']).toContain(connection.type);
    expect(typeof connection.multiple).toBe('boolean');

    if (connection.type === 'kind') {
      expect(Object.values(NodeKind)).toContain(connection.value);
    } else {
      expect(typeof connection.value).toBe('string');
      expect(connection.value.length).toBeGreaterThan(0);
    }
  };

  const getTemplateById = async (id: string) => {
    const templates = await templatesService.getAllTemplates();
    return templates.find((template) => template.id === id);
  };

  beforeAll(async () => {
    app = await createTestModule();
    templatesService = app.get(TemplatesService);
    templateRegistry = app.get(TemplateRegistry);
  });

  afterAll(async () => {
    // Suppress BullMQ Redis duplicate connection close errors during teardown.
    // BullMQ internally duplicates the shared IORedis connection for Queue/Worker.
    // These duplicates may reject pending commands during app shutdown, producing
    // unhandled rejections that don't affect test correctness.
    const suppressRedisClose = (reason: unknown) => {
      if (
        reason instanceof Error &&
        reason.message === 'Connection is closed.'
      ) {
        return;
      }
      throw reason;
    };
    process.on('unhandledRejection', suppressRedisClose);

    await app.close();

    process.removeListener('unhandledRejection', suppressRedisClose);
  });

  it('returns all registered templates sorted by kind and matching the public DTO schema', async () => {
    const templates = await templatesService.getAllTemplates();

    expect(Array.isArray(templates)).toBe(true);
    expect(templates.length).toBeGreaterThan(0);

    const kinds = templates.map((template) => template.kind);
    expect(kinds).toEqual([...kinds].sort());

    const uniqueNames = new Set<string>();
    for (const template of templates) {
      const parsed = TemplateSchema.safeParse(template);
      expect(parsed.success).toBe(true);

      expect(typeof template.schema).toBe('object');
      expect(template.schema).toHaveProperty('$schema');

      template.inputs?.forEach((connection) =>
        expectValidConnection(connection),
      );
      template.outputs?.forEach((connection) =>
        expectValidConnection(connection),
      );

      uniqueNames.add(template.name);
    }

    expect(uniqueNames.size).toBe(templates.length);
  });

  it('exposes manual trigger template that targets simple agents', async () => {
    const manualTrigger = await getTemplateById('manual-trigger');

    expect(manualTrigger).toBeDefined();
    expect(manualTrigger?.kind).toBe(NodeKind.Trigger);
    expect(manualTrigger?.inputs).toEqual([]);
    expect(manualTrigger?.outputs).toEqual([
      {
        type: 'kind',
        value: NodeKind.SimpleAgent,
        multiple: true,
        required: true,
      },
    ]);
    expect(manualTrigger?.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
  });

  it('links the simple agent template with triggers, tools, and communication helper', async () => {
    const simpleAgent = await getTemplateById('simple-agent');

    expect(simpleAgent).toBeDefined();
    expect(simpleAgent?.kind).toBe(NodeKind.SimpleAgent);
    expect(simpleAgent?.inputs).toEqual([
      {
        type: 'template',
        value: 'agent-communication-tool',
        multiple: true,
      },
      {
        type: 'kind',
        value: NodeKind.Trigger,
        multiple: true,
      },
    ]);
    expect(simpleAgent?.outputs).toEqual([
      {
        type: 'kind',
        value: NodeKind.Tool,
        multiple: true,
      },
      {
        type: 'kind',
        value: NodeKind.Mcp,
        multiple: true,
      },
      {
        type: 'kind',
        value: NodeKind.Instruction,
        multiple: true,
      },
    ]);
    expect(simpleAgent?.schema).toMatchObject({
      type: 'object',
      properties: expect.any(Object),
    });
  });

  it('exposes a knowledge tools template for agents', async () => {
    const knowledgeTools = await getTemplateById('knowledge-tools');

    expect(knowledgeTools).toBeDefined();
    expect(knowledgeTools?.kind).toBe(NodeKind.Tool);
    expect(knowledgeTools?.inputs).toEqual([
      {
        type: 'kind',
        value: NodeKind.SimpleAgent,
        multiple: true,
      },
    ]);
    expect(knowledgeTools?.outputs).toEqual([]);
    expect(knowledgeTools?.schema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        tags: expect.any(Object),
      }),
    });
  });

  it('serializes template metadata without leaking registry references', async () => {
    const serialized = await templatesService.getAllTemplates();
    const registryTemplates = templateRegistry.getAllTemplates();

    const byName = new Map(
      serialized.map((template) => [template.name, template]),
    );

    expect(byName.size).toBe(registryTemplates.length);

    for (const template of registryTemplates) {
      const serializedTemplate = byName.get(template.name);
      expect(serializedTemplate).toBeDefined();

      if (template.inputs) {
        expect(serializedTemplate!.inputs).toEqual(template.inputs);
        expect(serializedTemplate!.inputs).not.toBe(template.inputs);
      } else {
        expect(serializedTemplate!.inputs).toBeUndefined();
      }

      if (template.outputs) {
        expect(serializedTemplate!.outputs).toEqual(template.outputs);
        expect(serializedTemplate!.outputs).not.toBe(template.outputs);
      } else {
        expect(serializedTemplate!.outputs).toBeUndefined();
      }
    }
  });
});
