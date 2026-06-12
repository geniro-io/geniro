import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { NodeKind } from '../../graphs/graphs.types';

const NodeConnectionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('kind'),
    value: z.enum(NodeKind),
    required: z.boolean().optional(),
    requiredGroup: z.string().optional(),
    multiple: z.boolean(),
  }),
  z.object({
    type: z.literal('template'),
    value: z.string(),
    required: z.boolean().optional(),
    requiredGroup: z.string().optional(),
    multiple: z.boolean(),
  }),
]);

export const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(NodeKind),
  schema: z.record(z.string(), z.unknown()),
  inputs: z.array(NodeConnectionSchema).optional(),
  outputs: z.array(NodeConnectionSchema).optional(),
  // System agent metadata (present only for system agent templates)
  systemAgentId: z.string().optional(),
  systemAgentContentHash: z.string().optional(),
  systemAgentPredefinedTools: z.array(z.string()).optional(),
  // Instruction block metadata (present only for predefined instruction block templates)
  instructionBlockId: z.string().optional(),
  instructionBlockContentHash: z.string().optional(),
});

export class TemplateDto extends createZodDto(TemplateSchema) {}
