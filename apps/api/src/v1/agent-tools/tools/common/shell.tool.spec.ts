import { ToolRunnableConfig } from '@langchain/core/tools';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../../environments';
import { BaseAgentConfigurable } from '../../../agents/agents.types';
import { LitellmService } from '../../../litellm/services/litellm.service';
import { LlmModelsService } from '../../../litellm/services/llm-models.service';
import { OpenaiService } from '../../../openai/openai.service';
import { BaseRuntime } from '../../../runtime/services/base-runtime';
import { RuntimeThreadProvider } from '../../../runtime/services/runtime-thread-provider';
import { ShellTool, ShellToolOptions } from './shell.tool';

vi.mock('../../../../environments', () => ({
  environment: {
    toolMaxOutputTokens: 5000,
  },
}));

describe('ShellTool', () => {
  let tool: ShellTool;
  let mockRuntime: BaseRuntime;
  let mockRuntimeThreadProvider: RuntimeThreadProvider;
  let mockOpenaiService: OpenaiService;
  let mockLitellmService: LitellmService;
  let mockLlmModelsService: LlmModelsService;
  const defaultCfg: ToolRunnableConfig<BaseAgentConfigurable> = {
    configurable: {
      thread_id: 'thread-123',
    },
  };

  beforeEach(async () => {
    mockRuntime = {
      exec: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
    } as unknown as BaseRuntime;
    mockRuntimeThreadProvider = {
      provide: vi.fn().mockResolvedValue(mockRuntime),
      getRuntimeInfo: vi.fn().mockReturnValue(''),
    } as unknown as RuntimeThreadProvider;

    mockOpenaiService = {
      response: vi.fn().mockResolvedValue({
        content: 'extracted output',
        conversationId: 'conv-1',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      }),
      complete: vi.fn().mockResolvedValue({
        content: 'extracted output',
        conversationId: 'conv-1',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      }),
    } as unknown as OpenaiService;

    mockLitellmService = {
      supportsResponsesApi: vi.fn().mockResolvedValue(true),
      countTokens: vi.fn().mockResolvedValue(100),
    } as unknown as LitellmService;

    mockLlmModelsService = {
      getKnowledgeSearchModel: vi.fn().mockReturnValue('gpt-5-mini'),
    } as unknown as LlmModelsService;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShellTool,
        { provide: OpenaiService, useValue: mockOpenaiService },
        { provide: LitellmService, useValue: mockLitellmService },
        { provide: LlmModelsService, useValue: mockLlmModelsService },
      ],
    }).compile();

    tool = module.get<ShellTool>(ShellTool);
  });

  describe('schema', () => {
    it('should validate required purpose and command fields', () => {
      const validData = {
        purpose: 'Testing echo command',
        command: 'echo "hello"',
      };
      expect(() => tool.validate(validData)).not.toThrow();
    });

    it('should reject missing purpose field', () => {
      const invalidData = { command: 'echo "hello"' };
      expect(() => tool.validate(invalidData)).toThrow();
    });

    it('should reject missing command field', () => {
      const invalidData = { purpose: 'Testing command' };
      expect(() => tool.validate(invalidData)).toThrow();
    });

    it('should reject empty purpose', () => {
      const invalidData = { purpose: '', command: 'echo "hello"' };
      expect(() => tool.validate(invalidData)).toThrow();
    });

    it('should validate optional fields', () => {
      const validData = {
        purpose: 'Testing with all options',
        command: 'echo "hello"',
        timeoutMs: 5000,
        tailTimeoutMs: 2000,
        environmentVariables: [
          { name: 'NODE_ENV', value: 'test' },
          { name: 'DEBUG', value: 'true' },
        ],
      };
      expect(() => tool.validate(validData)).not.toThrow();
    });

    it('should validate positive timeout', () => {
      const validData = {
        purpose: 'Testing timeout',
        command: 'echo "hello"',
        timeoutMs: 1000,
      };
      expect(() => tool.validate(validData)).not.toThrow();
    });

    it('should reject negative timeout', () => {
      const invalidData = {
        purpose: 'Testing timeout',
        command: 'echo "hello"',
        timeoutMs: -1000,
      };
      expect(() => tool.validate(invalidData)).toThrow();
    });

    it('should reject zero timeout', () => {
      const invalidData = {
        purpose: 'Testing timeout',
        command: 'echo "hello"',
        timeoutMs: 0,
      };
      expect(() => tool.validate(invalidData)).toThrow();
    });

    it('should validate positive tail timeout', () => {
      const validData = {
        purpose: 'Testing tail timeout',
        command: 'echo "hello"',
        tailTimeoutMs: 1000,
      };
      expect(() => tool.validate(validData)).not.toThrow();
    });

    it('should reject negative tail timeout', () => {
      const invalidData = {
        purpose: 'Testing tail timeout',
        command: 'echo "hello"',
        tailTimeoutMs: -1000,
      };
      expect(() => tool.validate(invalidData)).toThrow();
    });

    it('should reject zero tail timeout', () => {
      const invalidData = {
        purpose: 'Testing tail timeout',
        command: 'echo "hello"',
        tailTimeoutMs: 0,
      };
      expect(() => tool.validate(invalidData)).toThrow();
    });
  });

  describe('build', () => {
    it('should create a DynamicStructuredTool', () => {
      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      expect(builtTool).toBeDefined();
      expect(typeof builtTool.invoke).toBe('function');
      expect(builtTool.name).toBe('shell');
    });

    it('should execute command with runtime', async () => {
      const mockExecResult = {
        stdout: 'hello world',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { output } = await builtTool.invoke(
        {
          purpose: 'Testing echo command',
          command: 'echo "hello world"',
        },
        defaultCfg,
      );

      expect(mockRuntime.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: 'echo "hello world"',
          metadata: expect.any(Object),
        }),
      );
      expect(output).toEqual({
        exitCode: mockExecResult.exitCode,
        stdout: mockExecResult.stdout,
        stderr: mockExecResult.stderr,
      });
    });

    it('should include generated title in message metadata', async () => {
      const mockExecResult = {
        stdout: 'hello world',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { messageMetadata } = await builtTool.invoke(
        {
          purpose: 'Testing echo command',
          command: 'echo "hello world"',
        },
        defaultCfg,
      );

      expect(messageMetadata?.__title).toBe('Testing echo command');
    });

    it('should execute command with environment variables', async () => {
      const mockExecResult = {
        stdout: 'test',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const environmentVariables = [{ name: 'NODE_ENV', value: 'test' }];
      const { output } = await builtTool.invoke(
        {
          purpose: 'Testing environment variables',
          command: 'echo $NODE_ENV',
          environmentVariables,
        },
        defaultCfg,
      );

      expect(mockRuntime.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: 'echo $NODE_ENV',
          env: expect.objectContaining({
            NODE_ENV: 'test',
          }),
          metadata: expect.any(Object),
        }),
      );
      expect(output).toEqual({
        exitCode: mockExecResult.exitCode,
        stdout: mockExecResult.stdout,
        stderr: mockExecResult.stderr,
      });
    });

    it('should execute command with all options', async () => {
      const mockExecResult = {
        stdout: 'success',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const environmentVariables = [{ name: 'TEST', value: 'value' }];
      const { output } = await builtTool.invoke(
        {
          purpose: 'Testing all options',
          command: 'pwd',
          timeoutMs: 5000,
          tailTimeoutMs: 2000,
          environmentVariables,
        },
        defaultCfg,
      );

      expect(mockRuntime.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: 'pwd',
          timeoutMs: 5000,
          tailTimeoutMs: 2000,
          env: expect.objectContaining({
            TEST: 'value',
          }),
          metadata: expect.any(Object),
        }),
      );
      expect(output).toEqual({
        exitCode: mockExecResult.exitCode,
        stdout: mockExecResult.stdout,
        stderr: mockExecResult.stderr,
      });
    });

    it('automatically sets sessionId based on thread id (not run id)', async () => {
      const mockExecResult = {
        stdout: 'session',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { output: result } = await builtTool.invoke(
        {
          purpose: 'Testing persistent session',
          command: 'echo "session"',
        },
        {
          configurable: {
            run_id: 'run-123',
            thread_id: 'thread-abc',
          },
        } as ToolRunnableConfig<BaseAgentConfigurable>,
      );

      expect(mockRuntime.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'thread-abc',
          cmd: 'echo "session"',
          metadata: expect.objectContaining({
            threadId: 'thread-abc',
            runId: 'run-123',
          }),
        }),
      );
      expect(result.exitCode).toBe(0);
    });

    it('throws error when thread_id is missing', async () => {
      const mockExecResult = {
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { output: result } = await builtTool.invoke(
        {
          purpose: 'Testing missing thread id',
          command: 'pwd',
        },
        {
          configurable: {
            run_id: 'run-xyz',
          },
        } as ToolRunnableConfig<BaseAgentConfigurable>,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'Thread id is required for tool execution',
      );
    });

    it('should handle runtime execution errors', async () => {
      const mockError = new Error('Runtime not started');
      mockRuntime.exec = vi.fn().mockRejectedValue(mockError);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { output: result } = await builtTool.invoke(
        {
          purpose: 'Testing error handling',
          command: 'invalid-command',
        },
        defaultCfg,
      );

      expect(result).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: 'Runtime not started',
      });
    });

    it('should convert environmentVariables array to object correctly', async () => {
      const mockExecResult = {
        stdout: 'output',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      await builtTool.invoke(
        {
          purpose: 'Testing environment variable conversion',
          command: 'env',
          environmentVariables: [
            { name: 'VAR1', value: 'value1' },
            { name: 'VAR2', value: 'value2' },
          ],
        },
        defaultCfg,
      );

      expect(mockRuntime.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: 'env',
          env: expect.objectContaining({
            VAR1: 'value1',
            VAR2: 'value2',
          }),
          metadata: expect.any(Object),
        }),
      );
    });

    it('should execute command with tailTimeoutMs only', async () => {
      const mockExecResult = {
        stdout: 'output',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      await builtTool.invoke(
        {
          purpose: 'Testing tail timeout',
          command: 'echo "test"',
          tailTimeoutMs: 3000,
        },
        defaultCfg,
      );

      expect(mockRuntime.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: 'echo "test"',
          tailTimeoutMs: 3000,
          metadata: expect.any(Object),
        }),
      );
    });
  });

  describe('resource integration', () => {
    it('should use environment variables from input', async () => {
      const mockExecResult = {
        stdout: 'merged',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      await builtTool.invoke(
        {
          purpose: 'Testing input environment variables',
          command: 'echo $GITHUB_PAT_TOKEN',
          environmentVariables: [
            { name: 'GITHUB_PAT_TOKEN', value: 'ghp_token123' },
            {
              name: 'GIT_REPO_URL',
              value: 'https://github.com/user/repo.git',
            },
          ],
        },
        defaultCfg,
      );

      expect(mockRuntime.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: 'echo $GITHUB_PAT_TOKEN',
          env: expect.objectContaining({
            GITHUB_PAT_TOKEN: 'ghp_token123',
            GIT_REPO_URL: 'https://github.com/user/repo.git',
          }),
          metadata: expect.any(Object),
        }),
      );
    });

    it('should use the last value when env names repeat', async () => {
      const mockExecResult = {
        stdout: 'overridden',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      await builtTool.invoke(
        {
          purpose: 'Testing repeated environment variables',
          command: 'echo $GITHUB_PAT_TOKEN',
          environmentVariables: [
            { name: 'GITHUB_PAT_TOKEN', value: 'ghp_config_token' },
            { name: 'GITHUB_PAT_TOKEN', value: 'ghp_provided_token' },
          ],
        },
        defaultCfg,
      );

      expect(mockRuntime.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: 'echo $GITHUB_PAT_TOKEN',
          env: expect.objectContaining({
            GITHUB_PAT_TOKEN: 'ghp_provided_token',
          }),
          metadata: expect.any(Object),
        }),
      );
    });

    it('should handle config without environment variables', async () => {
      const mockExecResult = {
        stdout: 'no env',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      await builtTool.invoke(
        {
          purpose: 'Testing without environment variables',
          command: 'echo "test"',
        },
        defaultCfg,
      );

      expect(mockRuntime.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: 'echo "test"',
          metadata: expect.any(Object),
        }),
      );
    });

    it('should handle empty environment variables object', async () => {
      const mockExecResult = {
        stdout: 'empty',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      await builtTool.invoke(
        {
          purpose: 'Testing with empty environment variables',
          command: 'echo "test"',
        },
        defaultCfg,
      );

      expect(mockRuntime.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: 'echo "test"',
          metadata: expect.any(Object),
        }),
      );
    });

    it('should use original description when no resource information provided', () => {
      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };

      const builtTool = tool.build(config);

      expect(builtTool.description).toBe(tool.description);
      expect(builtTool.description).not.toContain('Available Resources:');
    });
  });

  describe('output truncation (env-based token limit)', () => {
    // Default: toolMaxOutputTokens=5000, so maxChars = 5000 * 4 = 20000

    it('should trim stdout when it exceeds the env-based character limit', async () => {
      const longOutput = 'a'.repeat(25000);
      const mockExecResult = {
        stdout: longOutput,
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { output: result } = await builtTool.invoke(
        {
          purpose: 'Testing output trimming',
          command: 'echo "long output"',
        },
        defaultCfg,
      );

      expect(result.stdout).toHaveLength(20000);
      expect(result.stdout).toBe(longOutput.slice(-20000));
      expect(result.exitCode).toBe(0);
    });

    it('should trim stderr when it exceeds the env-based character limit', async () => {
      const longError = 'b'.repeat(25000);
      const mockExecResult = {
        stdout: '',
        stderr: longError,
        exitCode: 1,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { output: result } = await builtTool.invoke(
        {
          purpose: 'Testing error trimming',
          command: 'invalid-command',
        },
        defaultCfg,
      );

      expect(result.stderr).toHaveLength(20000);
      expect(result.stderr).toBe(longError.slice(-20000));
      expect(result.exitCode).toBe(1);
    });

    it('should trim both stdout and stderr when they exceed the limit', async () => {
      const longStdout = 'x'.repeat(25000);
      const longStderr = 'y'.repeat(25000);
      const mockExecResult = {
        stdout: longStdout,
        stderr: longStderr,
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { output: result } = await builtTool.invoke(
        {
          purpose: 'Testing both outputs trimming',
          command: 'some-command',
        },
        defaultCfg,
      );

      expect(result.stdout).toHaveLength(20000);
      expect(result.stdout).toBe(longStdout.slice(-20000));
      expect(result.stderr).toHaveLength(20000);
      expect(result.stderr).toBe(longStderr.slice(-20000));
    });

    it('should not trim output when it is within the limit', async () => {
      const shortOutput = 'short output';
      const mockExecResult = {
        stdout: shortOutput,
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { output: result } = await builtTool.invoke(
        {
          purpose: 'Testing no trimming needed',
          command: 'echo "short"',
        },
        defaultCfg,
      );

      expect(result.stdout).toBe(shortOutput);
      expect(result.stdout).toHaveLength(shortOutput.length);
    });

    it('should respect custom toolMaxOutputTokens from environment', async () => {
      const envMock = environment as { toolMaxOutputTokens: number };
      const original = envMock.toolMaxOutputTokens;
      envMock.toolMaxOutputTokens = 1000;

      try {
        const longOutput = 'z'.repeat(10000);
        const mockExecResult = {
          stdout: longOutput,
          stderr: '',
          exitCode: 0,
        };
        mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

        const config: ShellToolOptions = {
          runtimeProvider: mockRuntimeThreadProvider,
        };
        const builtTool = tool.build(config);

        const { output: result } = await builtTool.invoke(
          {
            purpose: 'Testing custom token limit',
            command: 'echo "long"',
          },
          defaultCfg,
        );

        // 1000 tokens * 4 chars/token = 4000 chars
        expect(result.stdout).toHaveLength(4000);
        expect(result.stdout).toBe(longOutput.slice(-4000));
      } finally {
        envMock.toolMaxOutputTokens = original;
      }
    });

    it('should trim error messages when runtime execution fails', async () => {
      const longErrorMessage = 'Error: '.repeat(5000);
      mockRuntime.exec = vi.fn().mockRejectedValue(new Error(longErrorMessage));

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { output: result } = await builtTool.invoke(
        {
          purpose: 'Testing error message trimming',
          command: 'invalid-command',
        },
        defaultCfg,
      );

      // Default: 5000 tokens * 4 = 20000 chars
      expect(result.stderr).toHaveLength(20000);
      expect(result.stderr).toBe(longErrorMessage.slice(-20000));
      expect(result.exitCode).toBe(1);
    });
  });

  describe('outputFocus', () => {
    it('should accept outputFocus as an optional schema field', () => {
      const validData = {
        purpose: 'Run tests',
        command: 'npm test',
        outputFocus: 'only failing test names and error messages',
      };
      expect(() => tool.validate(validData)).not.toThrow();
    });

    it('should validate without outputFocus', () => {
      const validData = {
        purpose: 'Run tests',
        command: 'npm test',
      };
      expect(() => tool.validate(validData)).not.toThrow();
    });

    it('should call LLM and return focusResult when outputFocus is set', async () => {
      const mockExecResult = {
        stdout: 'PASS test1\nFAIL test2\nError: expected true',
        stderr: '',
        exitCode: 1,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);
      vi.mocked(mockOpenaiService.response).mockResolvedValueOnce({
        content: 'FAIL test2: Error: expected true',
        conversationId: 'conv-1',
        usage: {
          inputTokens: 50,
          outputTokens: 10,
          totalTokens: 60,
          totalPrice: 0,
        },
      });

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { output, toolRequestUsage } = await builtTool.invoke(
        {
          purpose: 'Run tests',
          command: 'npm test',
          outputFocus: 'only failing test names and error messages',
        },
        defaultCfg,
      );

      expect(output.focusResult).toBe('FAIL test2: Error: expected true');
      expect(output.stdout).toBe('');
      expect(output.stderr).toBe('');
      expect(output.exitCode).toBe(1);
      expect(toolRequestUsage).toEqual({
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
        totalPrice: 0,
      });
      expect(mockOpenaiService.response).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5-mini',
          message: expect.stringContaining('only failing test names'),
        }),
      );
    });

    it('should not call LLM when outputFocus is omitted', async () => {
      const mockExecResult = {
        stdout: 'hello',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { output } = await builtTool.invoke(
        {
          purpose: 'Echo test',
          command: 'echo hello',
        },
        defaultCfg,
      );

      expect(output).not.toHaveProperty('focusResult');
      expect(output.stdout).toBe('hello');
      expect(mockOpenaiService.response).not.toHaveBeenCalled();
      expect(mockOpenaiService.complete).not.toHaveBeenCalled();
    });

    it('should call LLM for focused extraction on runtime error', async () => {
      mockRuntime.exec = vi
        .fn()
        .mockRejectedValue(new Error('Runtime crashed'));
      vi.mocked(mockOpenaiService.response).mockResolvedValueOnce({
        content: 'Runtime crashed',
        conversationId: 'conv-2',
        usage: {
          inputTokens: 30,
          outputTokens: 5,
          totalTokens: 35,
          totalPrice: 0,
        },
      });

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { output, toolRequestUsage } = await builtTool.invoke(
        {
          purpose: 'Run build',
          command: 'npm run build',
          outputFocus: 'only the first error',
        },
        defaultCfg,
      );

      expect(output.exitCode).toBe(1);
      expect(output.focusResult).toBe('Runtime crashed');
      expect(output.stdout).toBe('');
      expect(output.stderr).toBe('');
      expect(toolRequestUsage).toBeDefined();
    });

    it('should fall back to raw output when LLM extraction fails', async () => {
      const mockExecResult = {
        stdout: 'raw output data',
        stderr: 'some warning',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);
      vi.mocked(mockOpenaiService.response).mockRejectedValueOnce(
        new Error('LLM unavailable'),
      );

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { output, toolRequestUsage } = await builtTool.invoke(
        {
          purpose: 'Run command',
          command: 'some-command',
          outputFocus: 'errors only',
        },
        defaultCfg,
      );

      // Falls back to raw output
      expect(output).not.toHaveProperty('focusResult');
      expect(output.stdout).toBe('raw output data');
      expect(output.stderr).toBe('some warning');
      expect(output.exitCode).toBe(0);
      expect(toolRequestUsage).toBeUndefined();
    });

    it('should use complete() when responses API is not supported', async () => {
      const mockExecResult = {
        stdout: 'output data',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);
      vi.mocked(mockLitellmService.supportsResponsesApi).mockResolvedValueOnce(
        false,
      );
      vi.mocked(mockOpenaiService.complete).mockResolvedValueOnce({
        content: 'focused content',
        conversationId: 'conv-3',
        usage: {
          inputTokens: 40,
          outputTokens: 8,
          totalTokens: 48,
          totalPrice: 0,
        },
      });

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { output } = await builtTool.invoke(
        {
          purpose: 'Check output',
          command: 'cat log.txt',
          outputFocus: 'error lines',
        },
        defaultCfg,
      );

      expect(output.focusResult).toBe('focused content');
      expect(mockOpenaiService.complete).toHaveBeenCalled();
      expect(mockOpenaiService.response).not.toHaveBeenCalled();
    });

    it('should truncate raw output before sending to LLM when outputFocus is set', async () => {
      // Default budget: 5000 tokens * 4 = 20000 chars
      // With outputFocus: 25% = 5000 chars
      const longOutput = 'x'.repeat(10000);
      const mockExecResult = {
        stdout: longOutput,
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      await builtTool.invoke(
        {
          purpose: 'List files',
          command: 'find /workspace',
          outputFocus: 'only .ts files',
        },
        defaultCfg,
      );

      // The LLM should receive the truncated output (5000 chars from tail)
      const calls = vi.mocked(mockOpenaiService.response).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const llmMessage = (calls[0]![0] as { message: string }).message;
      expect(llmMessage).toContain(longOutput.slice(-5000));
      expect(llmMessage).not.toContain(longOutput);
    });

    it('should not aggressively truncate when outputFocus is omitted', async () => {
      const longOutput = 'x'.repeat(10000);
      const mockExecResult = {
        stdout: longOutput,
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { output } = await builtTool.invoke(
        {
          purpose: 'List files',
          command: 'find /workspace',
        },
        defaultCfg,
      );

      // 10000 < 20000 full budget, so no truncation
      expect(output.stdout).toHaveLength(10000);
      expect(output.stdout).toBe(longOutput);
    });
  });

  describe('durationMs tracking', () => {
    it('should include durationMs in messageMetadata on successful execution', async () => {
      const mockExecResult = {
        stdout: 'hello world',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { messageMetadata } = await builtTool.invoke(
        {
          purpose: 'Testing duration tracking',
          command: 'echo "hello world"',
        },
        defaultCfg,
      );

      expect(messageMetadata?.__durationMs).toBeTypeOf('number');
      expect(messageMetadata!.__durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should include durationMs in messageMetadata on runtime error', async () => {
      mockRuntime.exec = vi
        .fn()
        .mockRejectedValue(new Error('Runtime not started'));

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { messageMetadata } = await builtTool.invoke(
        {
          purpose: 'Testing duration on error',
          command: 'invalid-command',
        },
        defaultCfg,
      );

      expect(messageMetadata?.__durationMs).toBeTypeOf('number');
      expect(messageMetadata!.__durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should include durationMs in messageMetadata when outputFocus is set', async () => {
      const mockExecResult = {
        stdout: 'PASS test1\nFAIL test2',
        stderr: '',
        exitCode: 1,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);
      vi.mocked(mockOpenaiService.response).mockResolvedValueOnce({
        content: 'FAIL test2',
        conversationId: 'conv-1',
        usage: {
          inputTokens: 50,
          outputTokens: 10,
          totalTokens: 60,
          totalPrice: 0,
        },
      });

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { messageMetadata } = await builtTool.invoke(
        {
          purpose: 'Run tests',
          command: 'npm test',
          outputFocus: 'only failing tests',
        },
        defaultCfg,
      );

      expect(messageMetadata?.__durationMs).toBeTypeOf('number');
      expect(messageMetadata!.__durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should include durationMs in messageMetadata on timeout (exitCode 124)', async () => {
      const mockExecResult = {
        stdout: '',
        stderr: '',
        exitCode: 124,
        timeout: 5000,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      const { messageMetadata } = await builtTool.invoke(
        {
          purpose: 'Testing timeout duration',
          command: 'sleep 999',
          timeoutMs: 5000,
        },
        defaultCfg,
      );

      expect(messageMetadata?.__durationMs).toBeTypeOf('number');
      expect(messageMetadata!.__durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('output env defaults', () => {
    it('should not add default env variables (now set in Dockerfile)', async () => {
      const mockExecResult = {
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
      };
      mockRuntime.exec = vi.fn().mockResolvedValue(mockExecResult);

      const config: ShellToolOptions = {
        runtimeProvider: mockRuntimeThreadProvider,
      };
      const builtTool = tool.build(config);

      await builtTool.invoke(
        {
          purpose: 'Testing env defaults',
          command: 'echo ok',
        },
        defaultCfg,
      );

      expect(mockRuntime.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          env: {}, // empty when no resolveEnv or environmentVariables provided
        }),
      );
    });
  });
});
