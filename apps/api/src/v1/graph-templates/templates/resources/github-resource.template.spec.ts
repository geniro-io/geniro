import { Test, TestingModule } from '@nestjs/testing';
import { DefaultLogger } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ResourceKind } from '../../../graph-resources/graph-resources.types';
import {
  GithubResource,
  IGithubResourceOutput,
} from '../../../graph-resources/services/github-resource';
import type { GraphNode } from '../../../graphs/graphs.types';
import { NodeKind } from '../../../graphs/graphs.types';
import {
  GithubResourceTemplate,
  GithubResourceTemplateSchema,
} from './github-resource.template';

describe('GithubResourceTemplate', () => {
  let template: GithubResourceTemplate;
  let mockGithubResource: GithubResource;

  beforeEach(async () => {
    mockGithubResource = {
      setup: vi.fn(),
      getData: vi.fn(),
      kind: 'Shell' as ResourceKind,
    } as unknown as GithubResource;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GithubResourceTemplate,
        {
          provide: GithubResource,
          useValue: mockGithubResource,
        },
        {
          provide: DefaultLogger,
          useValue: {
            error: vi.fn(),
            log: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
          },
        },
      ],
    }).compile();

    template = module.get<GithubResourceTemplate>(GithubResourceTemplate);
    vi.spyOn(template as any, 'createNewInstance').mockResolvedValue(
      mockGithubResource,
    );
  });

  describe('properties', () => {
    it('should have correct name', () => {
      expect(template.name).toBe('GitHub');
    });

    it('should have correct description', () => {
      expect(template.description).toContain('GitHub resource');
      expect(template.description).toContain('GitHub App');
    });

    it('should have correct kind', () => {
      expect(template.kind).toBe(NodeKind.Resource);
    });

    it('should have correct schema', () => {
      expect(template.schema).toBe(GithubResourceTemplateSchema);
    });

    it('accepts both SimpleAgent and ClaudeAgent as consumers', () => {
      const kinds = template.inputs
        .filter((i) => i.type === 'kind')
        .map((i) => i.value);
      expect(kinds).toContain(NodeKind.SimpleAgent);
      expect(kinds).toContain(NodeKind.ClaudeAgent);
    });
  });

  describe('schema validation', () => {
    it('should accept empty config with defaults', () => {
      const data = {};

      const parsed = GithubResourceTemplateSchema.parse(data);
      expect(parsed.auth).toBe(true);
    });

    it('should accept optional name field', () => {
      const validData = {
        name: 'Test User',
        auth: false,
      };

      expect(() => GithubResourceTemplateSchema.parse(validData)).not.toThrow();
    });

    it('should default auth to true when not specified', () => {
      const validData = {};

      const parsed = GithubResourceTemplateSchema.parse(validData);
      expect(parsed.auth).toBe(true);
    });

    it('should accept auth field explicitly', () => {
      const validData = {
        auth: false,
      };

      const parsed = GithubResourceTemplateSchema.parse(validData);
      expect(parsed.auth).toBe(false);
    });

    it('should ignore legacy/unknown fields via strip()', () => {
      const dataWithExtra = {
        patToken: 'ghp_1234567890abcdef',
        authMethod: 'pat',
        invalidField: 'value',
      };

      const parsed = GithubResourceTemplateSchema.parse(dataWithExtra);
      expect(parsed).not.toHaveProperty('patToken');
      expect(parsed).not.toHaveProperty('authMethod');
      expect(parsed).not.toHaveProperty('invalidField');
    });

    it('should parse existing legacy configs without errors', () => {
      const legacyConfig = {
        patToken: 'ghp_1234567890abcdef',
        authMethod: 'pat',
        name: 'Test User',
        email: 'test@example.com',
        auth: true,
      };

      const parsed = GithubResourceTemplateSchema.parse(legacyConfig);
      expect(parsed.name).toBe('Test User');
      expect(parsed.auth).toBe(true);
      expect(parsed).not.toHaveProperty('patToken');
      expect(parsed).not.toHaveProperty('authMethod');
    });
  });

  describe('create', () => {
    it('should call setup if available', async () => {
      const config = {
        auth: false,
      };

      const mockResolveEnv = vi.fn().mockResolvedValue({});
      const mockResolveToken = vi.fn().mockResolvedValue(null);
      const mockResourceOutput: IGithubResourceOutput = {
        information: 'GitHub resource information',
        kind: ResourceKind.Shell,
        resolveToken: mockResolveToken,
        data: {
          resolveEnv: mockResolveEnv,
          initScript: ['echo "setup"'],
        },
      };

      vi.mocked(mockGithubResource.setup!).mockResolvedValue(undefined);
      vi.mocked(mockGithubResource.getData).mockResolvedValue(
        mockResourceOutput,
      );

      const outputNodeIds = new Set<string>();
      const metadata = {
        graphId: 'test-graph',
        nodeId: 'test-node',
        version: '1.0.0',
        graph_created_by: 'user-1',
        graph_project_id: '11111111-1111-1111-1111-111111111111',
      };

      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata,
      };

      const instance = await handle.provide(init);
      expect(mockGithubResource.setup).not.toHaveBeenCalled();
      expect(mockGithubResource.getData).not.toHaveBeenCalled();

      await handle.configure(init, instance);

      expect(mockGithubResource.setup).toHaveBeenCalledWith(config);
      expect(mockGithubResource.getData).toHaveBeenCalledWith(config);
      expect(instance).toEqual(mockResourceOutput);
    });

    it('should work without setup method', async () => {
      const config = {
        auth: false,
      };

      const mockResolveEnv2 = vi.fn().mockResolvedValue({});
      const mockResolveToken2 = vi.fn().mockResolvedValue(null);
      const mockResourceOutput: IGithubResourceOutput = {
        information: 'GitHub resource information',
        kind: ResourceKind.Shell,
        resolveToken: mockResolveToken2,
        data: {
          resolveEnv: mockResolveEnv2,
          initScript: ['echo "setup"'],
        },
      };

      // Remove setup method
      delete (mockGithubResource as unknown as { setup?: unknown }).setup;
      vi.mocked(mockGithubResource.getData).mockResolvedValue(
        mockResourceOutput,
      );

      const outputNodeIds = new Set<string>();
      const metadata = {
        graphId: 'test-graph',
        nodeId: 'test-node',
        version: '1.0.0',
        graph_created_by: 'user-1',
        graph_project_id: '11111111-1111-1111-1111-111111111111',
      };

      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds,
        metadata,
      };

      const instance = await handle.provide(init);
      expect(mockGithubResource.getData).not.toHaveBeenCalled();

      await handle.configure(init, instance);

      expect(mockGithubResource.getData).toHaveBeenCalledWith(config);
      expect(instance).toEqual(mockResourceOutput);
    });

    it('should handle setup errors', async () => {
      const config = {
        auth: false,
      };

      const setupError = new Error('Setup failed');
      vi.mocked(mockGithubResource.setup!).mockRejectedValue(setupError);

      const metadata = {
        graphId: 'test-graph',
        nodeId: 'test-node',
        version: '1.0.0',
        graph_created_by: 'user-1',
        graph_project_id: '11111111-1111-1111-1111-111111111111',
      };

      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(init);

      await expect(handle.configure(init, instance)).rejects.toThrow(
        'Setup failed',
      );
    });

    it('should handle getData errors', async () => {
      const config = {
        auth: false,
      };

      const getDataError = new Error('GetData failed');
      vi.mocked(mockGithubResource.setup!).mockResolvedValue(undefined);
      vi.mocked(mockGithubResource.getData).mockRejectedValue(getDataError);

      const metadata = {
        graphId: 'test-graph',
        nodeId: 'test-node',
        version: '1.0.0',
        graph_created_by: 'user-1',
        graph_project_id: '11111111-1111-1111-1111-111111111111',
      };

      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(init);

      await expect(handle.configure(init, instance)).rejects.toThrow(
        'GetData failed',
      );
    });

    it('should pass correct config to both setup and getData', async () => {
      const config = {
        auth: true,
      };

      vi.mocked(mockGithubResource.setup!).mockResolvedValue(undefined);
      vi.mocked(mockGithubResource.getData).mockResolvedValue({} as never);

      const metadata = {
        graphId: 'test-graph',
        nodeId: 'test-node',
        version: '1.0.0',
        graph_created_by: 'user-1',
        graph_project_id: '11111111-1111-1111-1111-111111111111',
      };

      const handle = await template.create();
      const init: GraphNode<typeof config> = {
        config,
        inputNodeIds: new Set(),
        outputNodeIds: new Set(),
        metadata,
      };
      const instance = await handle.provide(init);
      await handle.configure(init, instance);

      expect(mockGithubResource.setup).toHaveBeenCalledWith(config);
      expect(mockGithubResource.getData).toHaveBeenCalledWith(config);
    });
  });
});
