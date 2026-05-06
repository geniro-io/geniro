import { ToolRunnableConfig } from '@langchain/core/tools';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { BaseException } from '@packages/common';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { environment } from '../../../environments';
import { FilesApplyChangesTool } from '../../../v1/agent-tools/tools/common/files/files-apply-changes.tool';
import { FilesDeleteTool } from '../../../v1/agent-tools/tools/common/files/files-delete.tool';
import { FilesFindPathsTool } from '../../../v1/agent-tools/tools/common/files/files-find-paths.tool';
import { FilesReadTool } from '../../../v1/agent-tools/tools/common/files/files-read.tool';
import { FilesSearchTextTool } from '../../../v1/agent-tools/tools/common/files/files-search-text.tool';
import { FilesWriteFileTool } from '../../../v1/agent-tools/tools/common/files/files-write-file.tool';
import { ShellTool } from '../../../v1/agent-tools/tools/common/shell.tool';
import {
  BaseAgentConfigurable,
  ReasoningEffort,
} from '../../../v1/agents/agents.types';
import { SimpleAgentSchemaType } from '../../../v1/agents/services/agents/simple-agent';
import { CreateGraphDto } from '../../../v1/graphs/dto/graphs.dto';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { GraphsService } from '../../../v1/graphs/services/graphs.service';
import { LiteLlmClient } from '../../../v1/litellm/services/litellm.client';
import { LitellmService } from '../../../v1/litellm/services/litellm.service';
import { LlmModelsService } from '../../../v1/litellm/services/llm-models.service';
import { OpenaiService } from '../../../v1/openai/openai.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { RuntimeType } from '../../../v1/runtime/runtime.types';
import { BaseRuntime } from '../../../v1/runtime/services/base-runtime';
import { DockerRuntime } from '../../../v1/runtime/services/docker-runtime';
import { RuntimeProvider } from '../../../v1/runtime/services/runtime-provider';
import { RuntimeThreadProvider } from '../../../v1/runtime/services/runtime-thread-provider';
import { ThreadMessageDto } from '../../../v1/threads/dto/threads.dto';
import { ThreadNameGeneratorService } from '../../../v1/threads/services/thread-name-generator.service';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { waitForCondition } from '../helpers/graph-helpers';
import { createTestProject } from '../helpers/test-context';
import {
  mockLiteLlmClient,
  mockThreadNameGenerator,
} from '../helpers/test-stubs';
import { getMockLlm } from '../mocks/mock-llm';
import { getMockRuntime } from '../mocks/mock-runtime';
import { createTestModule } from '../setup';

const THREAD_ID = `files-tools-int-${Date.now()}`;
const WORKSPACE_DIR = `/runtime-workspace/${THREAD_ID}`;
const INT_TEST_TIMEOUT = 60000;
const RUNNABLE_CONFIG: ToolRunnableConfig<BaseAgentConfigurable> = {
  configurable: {
    thread_id: THREAD_ID,
  },
};

/**
 * Strip NNN\t line-number prefixes returned by files_read so the raw content
 * can be fed to files_apply_changes (which expects un-numbered text).
 */
function stripLineNumbers(numberedContent: string): string {
  return numberedContent
    .split('\n')
    .map((line) => line.replace(/^\d+\t/, ''))
    .join('\n');
}

const SAMPLE_TS_CONTENT = [
  'export function greet(name: string) {',
  '  return `Hello, ${name}!`;',
  '}',
  '',
  'export class HelperService {',
  "  constructor(private prefix: string = 'helper') {}",
  '  run(task: string) {',
  '    return `${this.prefix}:${task}`;',
  '  }',
  '}',
].join('\n');

type SearchTextResult = Awaited<
  ReturnType<FilesSearchTextTool['invoke']>
>['output'];

const hasTextMatch = (result: SearchTextResult, snippet: string) =>
  Array.isArray(result.matches) &&
  result.matches.some(
    (match) =>
      typeof match?.lineText === 'string' && match.lineText.includes(snippet),
  );

// Assigned in beforeAll of the graph execution describe block once the test project is created.
let contextDataStorage: AppContextStorage;

describe('Files tools integration', () => {
  let moduleRef: TestingModule;
  let runtime: BaseRuntime;
  let runtimeThreadProvider: RuntimeThreadProvider;
  let filesFindPathsTool: FilesFindPathsTool;
  let filesReadTool: FilesReadTool;
  let filesSearchTextTool: FilesSearchTextTool;
  let filesApplyChangesTool: FilesApplyChangesTool;
  let filesWriteFileTool: FilesWriteFileTool;
  let filesDeleteTool: FilesDeleteTool;
  let shellTool: ShellTool;

  const writeSampleFile = async (fileName = 'sample.ts') => {
    const filePath = `${WORKSPACE_DIR}/${fileName}`;

    const { output: result } = await filesWriteFileTool.invoke(
      {
        filePath,
        fileContent: SAMPLE_TS_CONTENT,
      },
      { runtimeProvider: runtimeThreadProvider },
      RUNNABLE_CONFIG,
    );

    expect(result.success).toBe(true);

    return filePath;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        FilesFindPathsTool,
        FilesReadTool,
        FilesSearchTextTool,
        FilesApplyChangesTool,
        FilesWriteFileTool,
        FilesDeleteTool,
        ShellTool,
        { provide: OpenaiService, useValue: {} },
        { provide: LitellmService, useValue: {} },
        { provide: LlmModelsService, useValue: {} },
      ],
    }).compile();

    filesFindPathsTool = moduleRef.get(FilesFindPathsTool);
    filesReadTool = moduleRef.get(FilesReadTool);
    filesSearchTextTool = moduleRef.get(FilesSearchTextTool);
    filesApplyChangesTool = moduleRef.get(FilesApplyChangesTool);
    filesWriteFileTool = moduleRef.get(FilesWriteFileTool);
    filesDeleteTool = moduleRef.get(FilesDeleteTool);
    shellTool = moduleRef.get(ShellTool);

    runtime = new DockerRuntime({ socketPath: environment.dockerSocket });

    await runtime.start({
      image: environment.dockerRuntimeImage,
      recreate: true,
      containerName: `files-tools-${Date.now()}`,
    });

    runtimeThreadProvider = new RuntimeThreadProvider(
      {
        provide: async () => ({ runtime, created: false }),
      } as unknown as RuntimeProvider,
      {
        graphId: `graph-${Date.now()}`,
        runtimeNodeId: `runtime-${Date.now()}`,
        type: RuntimeType.Docker,
        runtimeStartParams: {
          image: environment.dockerRuntimeImage,
        },
        temporary: true,
      },
    );
  }, 60000);

  afterAll(async () => {
    if (runtime) {
      await runtime.stop().catch(() => undefined);
    }

    if (moduleRef) {
      await moduleRef.close();
    }
  }, 60000);

  it(
    'applies changes and searches text inside the runtime workspace',
    { timeout: INT_TEST_TIMEOUT },
    async () => {
      const filePath = await writeSampleFile('workspace.ts');

      // Read file first
      const { output: initialRead } = await filesReadTool.invoke(
        { filesToRead: [{ filePath }] },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      const initialContentNumbered = initialRead.files?.[0]?.content || '';
      const initialContent = stripLineNumbers(initialContentNumbered);

      const { output: insertResult } = await filesApplyChangesTool.invoke(
        {
          filePath,
          oldText: initialContent,
          newText: '// Integration header\n' + initialContent,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(insertResult.success).toBe(true);

      const { output: listResult } = await filesFindPathsTool.invoke(
        { searchInDirectory: WORKSPACE_DIR, filenamePattern: '*.ts' },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(listResult.error).toBeUndefined();
      expect(listResult.files).toBeDefined();
      expect(listResult.files).toContain(filePath);

      const { output: readResult } = await filesReadTool.invoke(
        { filesToRead: [{ filePath }] },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(readResult.error).toBeUndefined();
      const readContent = readResult.files?.[0]?.content;
      expect(readContent).toContain('// Integration header');
      expect(readContent).toContain('export function greet');

      const { output: searchResult } = await filesSearchTextTool.invoke(
        { filePath, textPattern: 'HelperService' },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(searchResult.error).toBeUndefined();
      expect(hasTextMatch(searchResult, 'class HelperService')).toBe(true);
    },
  );

  it(
    'uses current working directory when dir is omitted',
    { timeout: INT_TEST_TIMEOUT },
    async () => {
      // Write a file into the thread workspace (default child workdir)
      const filePath = await writeSampleFile('cwd-file.ts');

      const { output: listResult } = await filesFindPathsTool.invoke(
        { filenamePattern: '*.ts' },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(listResult.error).toBeUndefined();
      expect(listResult.files?.some((f) => f.endsWith('cwd-file.ts'))).toBe(
        true,
      );

      const { output: searchResult } = await filesSearchTextTool.invoke(
        { filePath, textPattern: 'HelperService' },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(searchResult.error).toBeUndefined();
      expect(hasTextMatch(searchResult, 'class HelperService')).toBe(true);
    },
  );

  it(
    'allows creating, cd-ing, and reading from a custom dir with persistent session',
    { timeout: INT_TEST_TIMEOUT },
    async () => {
      const builtShell = shellTool.build({
        runtimeProvider: runtimeThreadProvider,
      });
      const customDir = `${WORKSPACE_DIR}/nested/custom`;
      const filePath = `${customDir}/note.txt`;
      const content = 'Hello from custom dir';

      // Create file in a custom directory
      const { output: applyRes } = await filesWriteFileTool.invoke(
        {
          filePath,
          fileContent: content,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );
      expect(applyRes.success).toBe(true);

      // Move shell session into that directory and verify cwd
      const { output: cdRes } = await builtShell.invoke(
        { purpose: 'cd into custom dir', command: `cd ${customDir} && pwd` },
        RUNNABLE_CONFIG,
      );
      expect(cdRes.exitCode).toBe(0);
      expect(cdRes.stdout.trim()).toBe(customDir);

      // Use files_find_paths without dir to rely on current session cwd
      const { output: listRes } = await filesFindPathsTool.invoke(
        { filenamePattern: '*.txt' },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );
      expect(listRes.error).toBeUndefined();
      const listedFile = listRes.files?.find((f) => f.endsWith('/note.txt'));
      expect(listedFile).toBe(filePath);
      expect(listedFile?.startsWith(customDir)).toBe(true);

      // Read the file from the custom directory
      const { output: readRes } = await filesReadTool.invoke(
        { filesToRead: [{ filePath }] },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );
      expect(readRes.error).toBeUndefined();
      expect(stripLineNumbers(readRes.files?.[0]?.content || '').trim()).toBe(
        content,
      );
    },
  );

  it(
    'running tools with dir does not change persistent shell cwd',
    { timeout: INT_TEST_TIMEOUT },
    async () => {
      const builtShell = shellTool.build({
        runtimeProvider: runtimeThreadProvider,
      });

      const { output: setCwd } = await builtShell.invoke(
        { purpose: 'set cwd', command: 'cd /tmp && pwd' },
        RUNNABLE_CONFIG,
      );
      expect(setCwd.exitCode).toBe(0);
      expect(setCwd.stdout.trim()).toBe('/tmp');

      // Run files_find_paths with an explicit dir (subshell) and ensure cwd remains /tmp
      const { output: listResult } = await filesFindPathsTool.invoke(
        { searchInDirectory: WORKSPACE_DIR, filenamePattern: '*.ts' },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );
      expect(listResult.error).toBeUndefined();

      const { output: cwdResult } = await builtShell.invoke(
        { purpose: 'check cwd', command: 'pwd' },
        RUNNABLE_CONFIG,
      );
      expect(cwdResult.exitCode).toBe(0);
      expect(cwdResult.stdout.trim()).toBe('/tmp');
    },
  );

  it(
    'creates a file in new directories and deletes it via files_delete',
    { timeout: INT_TEST_TIMEOUT },
    async () => {
      const nestedDir = `${WORKSPACE_DIR}/nested/delete-check`;
      const fileName = `temp-file-${Date.now()}.txt`;
      const filePath = `${nestedDir}/${fileName}`;
      const content = 'temporary file content';

      const { output: createResult } = await filesWriteFileTool.invoke(
        {
          filePath,
          fileContent: content,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(createResult.success).toBe(true);

      const { output: listAfterCreate } = await filesFindPathsTool.invoke(
        {
          searchInDirectory: nestedDir,
          filenamePattern: fileName,
          includeSubdirectories: false,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );
      expect(listAfterCreate.error).toBeUndefined();
      expect(listAfterCreate.files).toContain(filePath);

      const { output: deleteResult } = await filesDeleteTool.invoke(
        { filePath },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(deleteResult.success).toBe(true);

      const { output: listAfterDelete } = await filesFindPathsTool.invoke(
        {
          searchInDirectory: nestedDir,
          filenamePattern: fileName,
          includeSubdirectories: false,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(listAfterDelete.error).toBeUndefined();
      expect(listAfterDelete.files?.includes(filePath)).toBe(false);
    },
  );

  it(
    'replaces text in a file using pattern matching',
    { timeout: INT_TEST_TIMEOUT },
    async () => {
      const filePath = `${WORKSPACE_DIR}/replace-test.ts`;

      // Create a file with initial content
      const initialContent = `export function oldFunction() {\n  return 'old value';\n}\n\nexport const config = 'old';`;

      const { output: createResult } = await filesWriteFileTool.invoke(
        {
          filePath,
          fileContent: initialContent,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(createResult.success).toBe(true);

      // Replace a specific function using pattern matching
      const { output: replaceResult } = await filesApplyChangesTool.invoke(
        {
          filePath,
          oldText: `export function oldFunction() {\n  return 'old value';\n}`,
          newText: `export function newFunction() {\n  return 'new value';\n}`,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(replaceResult.success).toBe(true);
      expect(replaceResult.appliedEdits).toBe(1);

      // Verify the replacement
      const { output: readResult } = await filesReadTool.invoke(
        { filesToRead: [{ filePath }] },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      const contentAfter = readResult.files?.[0]?.content || '';
      expect(contentAfter).toContain('newFunction');
      expect(contentAfter).toContain("return 'new value'");
      expect(contentAfter).not.toContain('oldFunction');
      expect(contentAfter).toContain("export const config = 'old'"); // Other content unchanged
    },
  );

  it(
    'inserts text at the beginning of a file',
    { timeout: INT_TEST_TIMEOUT },
    async () => {
      const filePath = `${WORKSPACE_DIR}/insert-beginning.ts`;

      // Create a file with initial content
      const initialContent = `export const data = 'value';\n\nfunction helper() {\n  return true;\n}`;

      const { output: createResult } = await filesWriteFileTool.invoke(
        {
          filePath,
          fileContent: initialContent,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(createResult.success).toBe(true);

      // Read current content
      const { output: readBefore } = await filesReadTool.invoke(
        { filesToRead: [{ filePath }] },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );
      const beforeContent = stripLineNumbers(
        readBefore.files?.[0]?.content || '',
      );

      // Insert import at the beginning
      const { output: insertResult } = await filesApplyChangesTool.invoke(
        {
          filePath,
          oldText: beforeContent,
          newText: `import { newImport } from './new';\n\n${beforeContent}`,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(insertResult.success).toBe(true);

      // Verify the insertion
      const { output: readAfter } = await filesReadTool.invoke(
        { filesToRead: [{ filePath }] },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      const inserted = readAfter.files?.[0]?.content || '';
      expect(inserted).toContain("import { newImport } from './new'");
      expect(inserted).toContain('export const data');
    },
  );

  it(
    'appends text to the end of a file',
    { timeout: INT_TEST_TIMEOUT },
    async () => {
      const filePath = `${WORKSPACE_DIR}/append-end.ts`;

      // Create a file with initial content
      const initialContent = `export const first = 'value';\n\nexport function existing() {\n  return 'exists';\n}`;

      const { output: createResult } = await filesWriteFileTool.invoke(
        {
          filePath,
          fileContent: initialContent,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(createResult.success).toBe(true);

      // Read current content
      const { output: readBefore } = await filesReadTool.invoke(
        { filesToRead: [{ filePath }] },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );
      const beforeContent = stripLineNumbers(
        readBefore.files?.[0]?.content || '',
      );

      // Append new function at the end
      const { output: appendResult } = await filesApplyChangesTool.invoke(
        {
          filePath,
          oldText: beforeContent,
          newText: `${beforeContent}\n\nexport function newFunction() {\n  return 'new';\n}`,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(appendResult.success).toBe(true);

      // Verify the append
      const { output: readAfter } = await filesReadTool.invoke(
        { filesToRead: [{ filePath }] },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      const afterAppend = readAfter.files?.[0]?.content || '';
      expect(afterAppend).toContain('export const first');
      expect(afterAppend).toContain('export function existing');
      expect(afterAppend).toContain('export function newFunction');

      // Verify order - newFunction should be at the end
      const lines = afterAppend.split('\n');
      const newFunctionIndex = lines.findIndex((l) =>
        l.includes('newFunction'),
      );
      const existingIndex = lines.findIndex((l) => l.includes('existing'));
      expect(newFunctionIndex).toBeGreaterThan(existingIndex);
    },
  );

  it(
    'inserts text in the middle of a file',
    { timeout: INT_TEST_TIMEOUT },
    async () => {
      const filePath = `${WORKSPACE_DIR}/insert-middle.ts`;

      // Create a file with initial content
      const initialContent = `export const config = {\n  api: 'http://localhost',\n  port: 3000,\n};`;

      const { output: createResult } = await filesWriteFileTool.invoke(
        {
          filePath,
          fileContent: initialContent,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(createResult.success).toBe(true);

      // Insert a new property in the middle
      const { output: insertResult } = await filesApplyChangesTool.invoke(
        {
          filePath,
          oldText: `export const config = {\n  api: 'http://localhost',\n  port: 3000,\n};`,
          newText: `export const config = {\n  api: 'http://localhost',\n  timeout: 5000,\n  port: 3000,\n};`,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(insertResult.success).toBe(true);

      // Verify the insertion
      const { output: readAfter } = await filesReadTool.invoke(
        { filesToRead: [{ filePath }] },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      const afterMid = readAfter.files?.[0]?.content || '';
      expect(afterMid).toContain('api:');
      expect(afterMid).toContain('timeout: 5000');
      expect(afterMid).toContain('port:');

      // Verify order - timeout should be between api and port
      const lines = afterMid.split('\n');
      const apiIndex = lines.findIndex((l) => l.includes('api:'));
      const timeoutIndex = lines.findIndex((l) => l.includes('timeout:'));
      const portIndex = lines.findIndex((l) => l.includes('port:'));

      expect(timeoutIndex).toBeGreaterThan(apiIndex);
      expect(portIndex).toBeGreaterThan(timeoutIndex);
    },
  );

  it(
    'works with empty files and adds content',
    { timeout: INT_TEST_TIMEOUT },
    async () => {
      const filePath = `${WORKSPACE_DIR}/empty-file.ts`;

      // Create an empty file using write tool
      const { output: createResult } = await filesWriteFileTool.invoke(
        {
          filePath,
          fileContent: '',
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(createResult.success).toBe(true);

      // Verify it's empty
      const { output: readEmpty } = await filesReadTool.invoke(
        { filesToRead: [{ filePath }] },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      // Empty file now gets a single numbered line: "1\t"
      expect(readEmpty.files?.[0]?.content).toBe('1\t');

      // Overwrite with content using write tool
      const { output: writeResult } = await filesWriteFileTool.invoke(
        {
          filePath,
          fileContent: `// First line\nexport const value = 'data';`,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(writeResult.success).toBe(true);

      // Verify content was added
      const { output: readAfter } = await filesReadTool.invoke(
        { filesToRead: [{ filePath }] },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      const after = readAfter.files?.[0]?.content || '';
      expect(after).toContain('// First line');
      expect(after).toContain("export const value = 'data'");
    },
  );

  it(
    'returns diff when applying changes',
    { timeout: INT_TEST_TIMEOUT },
    async () => {
      const filePath = `${WORKSPACE_DIR}/dryrun-test.ts`;

      // Create a file
      const initialContent = `export function test() {\n  return 'original';\n}`;

      const { output: createResult } = await filesWriteFileTool.invoke(
        {
          filePath,
          fileContent: initialContent,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(createResult.success).toBe(true);

      // Apply changes (no dryRun support)
      const { output: applyResult } = await filesApplyChangesTool.invoke(
        {
          filePath,
          oldText: `export function test() {\n  return 'original';\n}`,
          newText: `export function test() {\n  return 'modified';\n}`,
        },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      expect(applyResult.success).toBe(true);
      expect(applyResult.appliedEdits).toBe(1);
      expect(applyResult.diff).toBeDefined();
      expect(applyResult.diff).toContain("-  return 'original'");
      expect(applyResult.diff).toContain("+  return 'modified'");

      // Verify file was changed
      const { output: readAfterApply } = await filesReadTool.invoke(
        { filesToRead: [{ filePath }] },
        { runtimeProvider: runtimeThreadProvider },
        RUNNABLE_CONFIG,
      );

      const afterApply = readAfterApply.files?.[0]?.content || '';
      expect(afterApply).toContain('modified');
      expect(afterApply).not.toContain('original');
    },
  );

  describe('files_read: line numbers', () => {
    it(
      'returns numbered lines in NNN\\t format with startLine',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const filePath = `${WORKSPACE_DIR}/line-numbers-test.ts`;
        const content = 'first\nsecond\nthird';

        await filesWriteFileTool.invoke(
          { filePath, fileContent: content },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const { output: readResult } = await filesReadTool.invoke(
          { filesToRead: [{ filePath }] },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(readResult.error).toBeUndefined();
        const file = readResult.files?.[0];
        expect(file).toBeDefined();
        expect(file!.content).toContain('1\tfirst');
        expect(file!.content).toContain('2\tsecond');
        expect(file!.content).toContain('3\tthird');
        expect(file!.startLine).toBe(1);
      },
    );

    it(
      'returns correct startLine and numbering for line-range reads',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const filePath = `${WORKSPACE_DIR}/line-range-test.ts`;
        const content = Array.from(
          { length: 20 },
          (_, i) => `line${i + 1}`,
        ).join('\n');

        await filesWriteFileTool.invoke(
          { filePath, fileContent: content },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const { output: readResult } = await filesReadTool.invoke(
          {
            filesToRead: [{ filePath, fromLineNumber: 5, toLineNumber: 8 }],
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(readResult.error).toBeUndefined();
        const file = readResult.files?.[0];
        expect(file).toBeDefined();
        expect(file!.startLine).toBe(5);
        expect(file!.content).toContain('5\tline5');
        expect(file!.content).toContain('8\tline8');
        expect(file!.content).not.toContain('4\t');
        expect(file!.content).not.toContain('9\t');
      },
    );
  });

  describe('files_apply_changes: insertAfterLine mode', () => {
    it(
      'inserts content after a specific line number',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const filePath = `${WORKSPACE_DIR}/insert-after-line.ts`;
        const content = 'line1\nline2\nline3';

        await filesWriteFileTool.invoke(
          { filePath, fileContent: content },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const { output: insertResult } = await filesApplyChangesTool.invoke(
          {
            filePath,
            oldText: '',
            newText: 'inserted-line',
            insertAfterLine: 1,
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(insertResult.success).toBe(true);
        expect(insertResult.appliedEdits).toBe(1);
        expect(insertResult.postEditContext).toBeDefined();

        const { output: readResult } = await filesReadTool.invoke(
          { filesToRead: [{ filePath }] },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const lines = (readResult.files?.[0]?.content || '')
          .split('\n')
          .map((l) => l.replace(/^\d+\t/, ''));
        expect(lines[0]).toBe('line1');
        expect(lines[1]).toBe('inserted-line');
        expect(lines[2]).toBe('line2');
        expect(lines[3]).toBe('line3');
      },
    );

    it(
      'inserts at the beginning when insertAfterLine is 0',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const filePath = `${WORKSPACE_DIR}/insert-at-beginning.ts`;
        const content = 'existing-line';

        await filesWriteFileTool.invoke(
          { filePath, fileContent: content },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const { output: insertResult } = await filesApplyChangesTool.invoke(
          {
            filePath,
            oldText: '',
            newText: 'prepended-line',
            insertAfterLine: 0,
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(insertResult.success).toBe(true);

        const { output: readResult } = await filesReadTool.invoke(
          { filesToRead: [{ filePath }] },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const lines = (readResult.files?.[0]?.content || '')
          .split('\n')
          .map((l) => l.replace(/^\d+\t/, ''));
        expect(lines[0]).toBe('prepended-line');
        expect(lines[1]).toBe('existing-line');
      },
    );

    it(
      'rejects insertAfterLine when oldText is non-empty',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const filePath = `${WORKSPACE_DIR}/insert-invalid.ts`;

        await filesWriteFileTool.invoke(
          { filePath, fileContent: 'content' },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const { output: result } = await filesApplyChangesTool.invoke(
          {
            filePath,
            oldText: 'non-empty',
            newText: 'replacement',
            insertAfterLine: 1,
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('oldText must be an empty string');
      },
    );
  });

  describe('files_apply_changes: basic edit after read', () => {
    it(
      'applies edit after reading file',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const filePath = `${WORKSPACE_DIR}/hash-match.ts`;
        const content = 'const x = 1;';

        await filesWriteFileTool.invoke(
          { filePath, fileContent: content },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const { output: editResult } = await filesApplyChangesTool.invoke(
          {
            filePath,
            oldText: 'const x = 1;',
            newText: 'const x = 2;',
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(editResult.success).toBe(true);
      },
    );
  });

  describe('files_apply_changes: postEditContext in output', () => {
    it(
      'returns numbered postEditContext after a successful edit',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const filePath = `${WORKSPACE_DIR}/post-edit-context.ts`;
        const content = Array.from(
          { length: 20 },
          (_, i) => `line${i + 1}`,
        ).join('\n');

        await filesWriteFileTool.invoke(
          { filePath, fileContent: content },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const { output: editResult } = await filesApplyChangesTool.invoke(
          {
            filePath,
            oldText: 'line10',
            newText: 'REPLACED',
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(editResult.success).toBe(true);
        expect(editResult.postEditContext).toBeDefined();
        // Post-edit context should contain NNN\t format
        expect(editResult.postEditContext).toMatch(/\d+\t/);
        // Should contain the replaced line
        expect(editResult.postEditContext).toContain('REPLACED');
        // Should contain surrounding context
        expect(editResult.postEditContext).toContain('line9');
        expect(editResult.postEditContext).toContain('line11');
      },
    );
  });

  describe('files_apply_changes: progressive matching', () => {
    it(
      'matches with wrong indentation via trimmed fallback',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const filePath = `${WORKSPACE_DIR}/trimmed-match.ts`;
        const content = '    const indented = true;\n    return indented;';

        await filesWriteFileTool.invoke(
          { filePath, fileContent: content },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        // oldText has no indentation — exact match will fail, trimmed should succeed
        const { output: editResult } = await filesApplyChangesTool.invoke(
          {
            filePath,
            oldText: 'const indented = true;\nreturn indented;',
            newText: 'const indented = false;\nreturn indented;',
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(editResult.success).toBe(true);
        expect(editResult.matchStage).toBe('trimmed');

        const { output: readResult } = await filesReadTool.invoke(
          { filesToRead: [{ filePath }] },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const afterContent = readResult.files?.[0]?.content || '';
        expect(afterContent).toContain('false');
        expect(afterContent).not.toContain('true');
      },
    );

    it(
      'matches with minor quote style difference via fuzzy fallback',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const filePath = `${WORKSPACE_DIR}/fuzzy-match.ts`;
        const content = 'const msg = "hello world";';

        await filesWriteFileTool.invoke(
          { filePath, fileContent: content },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        // oldText uses single quotes — fuzzy match should catch this
        const { output: editResult } = await filesApplyChangesTool.invoke(
          {
            filePath,
            oldText: "const msg = 'hello world';",
            newText: "const msg = 'goodbye world';",
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(editResult.success).toBe(true);
        expect(editResult.matchStage).toBe('fuzzy');

        const { output: readResult } = await filesReadTool.invoke(
          { filesToRead: [{ filePath }] },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const afterContent = readResult.files?.[0]?.content || '';
        expect(afterContent).toContain('goodbye');
      },
    );

    it(
      'reports matchStage as exact when oldText matches exactly',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const filePath = `${WORKSPACE_DIR}/exact-match.ts`;
        const content = 'const val = 42;';

        await filesWriteFileTool.invoke(
          { filePath, fileContent: content },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const { output: editResult } = await filesApplyChangesTool.invoke(
          {
            filePath,
            oldText: 'const val = 42;',
            newText: 'const val = 99;',
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(editResult.success).toBe(true);
        expect(editResult.matchStage).toBe('exact');
      },
    );
  });

  describe('files_apply_changes: multi-edit mode', () => {
    it(
      'applies multiple edits atomically in one call',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const filePath = `${WORKSPACE_DIR}/multi-edit-success.ts`;
        const content = [
          "import { A } from './a';",
          '',
          'export function processA(data: string) {',
          '  return A.run(data);',
          '}',
          '',
          'export function formatOutput(result: string) {',
          '  return `result: ${result}`;',
          '}',
        ].join('\n');

        await filesWriteFileTool.invoke(
          { filePath, fileContent: content },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const { output: editResult } = await filesApplyChangesTool.invoke(
          {
            filePath,
            edits: [
              {
                oldText: "import { A } from './a';",
                newText: "import { A } from './a';\nimport { B } from './b';",
              },
              {
                oldText: '  return A.run(data);',
                newText: '  return B.wrap(A.run(data));',
              },
            ],
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(editResult.success).toBe(true);
        expect(editResult.appliedEdits).toBe(2);
        expect(editResult.totalEdits).toBe(2);
        expect(editResult.diff).toBeDefined();

        const { output: readResult } = await filesReadTool.invoke(
          { filesToRead: [{ filePath }] },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const afterContent = stripLineNumbers(
          readResult.files?.[0]?.content || '',
        );
        expect(afterContent).toContain("import { B } from './b'");
        expect(afterContent).toContain('B.wrap(A.run(data))');
        // Untouched content preserved
        expect(afterContent).toContain('export function formatOutput');
      },
    );

    it(
      'does not write file when a mid-array edit fails to match',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const filePath = `${WORKSPACE_DIR}/multi-edit-rollback.ts`;
        const content = 'const a = 1;\nconst b = 2;\nconst c = 3;';

        await filesWriteFileTool.invoke(
          { filePath, fileContent: content },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        // First edit matches, second does not
        const { output: editResult } = await filesApplyChangesTool.invoke(
          {
            filePath,
            edits: [
              { oldText: 'const a = 1;', newText: 'const a = 10;' },
              {
                oldText: 'const nonexistent = 99;',
                newText: 'const replaced = 99;',
              },
              { oldText: 'const c = 3;', newText: 'const c = 30;' },
            ],
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(editResult.success).toBe(false);
        expect(editResult.failedEditIndex).toBe(1);
        expect(editResult.error).toContain('Edit 1 failed');

        // File must be unchanged on disk
        const { output: readResult } = await filesReadTool.invoke(
          { filesToRead: [{ filePath }] },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const afterContent = stripLineNumbers(
          readResult.files?.[0]?.content || '',
        );
        expect(afterContent).toContain('const a = 1;');
        expect(afterContent).toContain('const b = 2;');
        expect(afterContent).toContain('const c = 3;');
      },
    );
  });

  describe('files_apply_changes: replaceAll mode', () => {
    it(
      'replaces all occurrences when replaceAll is true',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const filePath = `${WORKSPACE_DIR}/replace-all.ts`;
        const content = [
          "const step1 = 'pending';",
          'doWork();',
          "const step2 = 'pending';",
          'doMoreWork();',
          "const step3 = 'pending';",
        ].join('\n');

        await filesWriteFileTool.invoke(
          { filePath, fileContent: content },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        // Each "const stepN = 'pending';" is a unique full line,
        // but they all share the substring "'pending'" which is too short for a full-line match.
        // Use a full-line pattern that appears 3 times: doWork() appears only once.
        // Better approach: use lines that are truly identical.
        const filePath2 = `${WORKSPACE_DIR}/replace-all-2.ts`;
        const content2 = [
          '// TODO: implement',
          'function a() {}',
          '// TODO: implement',
          'function b() {}',
          '// TODO: implement',
        ].join('\n');

        await filesWriteFileTool.invoke(
          { filePath: filePath2, fileContent: content2 },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const { output: editResult } = await filesApplyChangesTool.invoke(
          {
            filePath: filePath2,
            oldText: '// TODO: implement',
            newText: '// DONE',
            replaceAll: true,
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(editResult.success).toBe(true);
        expect(editResult.appliedEdits).toBe(3);

        const { output: readResult } = await filesReadTool.invoke(
          { filesToRead: [{ filePath: filePath2 }] },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        const afterContent = stripLineNumbers(
          readResult.files?.[0]?.content || '',
        );
        expect(afterContent).not.toContain('TODO: implement');
        expect(afterContent.match(/\/\/ DONE/g)?.length).toBe(3);
        // Untouched content preserved
        expect(afterContent).toContain('function a() {}');
        expect(afterContent).toContain('function b() {}');
      },
    );
  });

  describe('files_read: batch read multiple files', () => {
    it(
      'reads multiple files in a single call with correct content and metadata',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const files = [
          { name: 'batch-a.ts', content: 'const a = 1;' },
          { name: 'batch-b.ts', content: 'const b = 2;\nconst b2 = 3;' },
          { name: 'batch-c.ts', content: 'const c = "hello";' },
        ];

        for (const f of files) {
          await filesWriteFileTool.invoke(
            {
              filePath: `${WORKSPACE_DIR}/${f.name}`,
              fileContent: f.content,
            },
            { runtimeProvider: runtimeThreadProvider },
            RUNNABLE_CONFIG,
          );
        }

        const { output: readResult } = await filesReadTool.invoke(
          {
            filesToRead: files.map((f) => ({
              filePath: `${WORKSPACE_DIR}/${f.name}`,
            })),
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(readResult.error).toBeUndefined();
        expect(readResult.files).toHaveLength(3);

        for (let i = 0; i < files.length; i++) {
          const file = readResult.files![i]!;
          expect(file.error).toBeUndefined();
          expect(file.filePath).toBe(`${WORKSPACE_DIR}/${files[i]!.name}`);
          expect(file.fileSizeBytes).toBeGreaterThan(0);
          const rawContent = stripLineNumbers(file.content || '');
          expect(rawContent).toBe(files[i]!.content);
        }

        // Second file has 2 lines
        expect(readResult.files![1]!.lineCount).toBe(2);
      },
    );
  });

  describe('files_search_text: glob filters', () => {
    it(
      'filters results with onlyInFilesMatching',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const searchDir = `${WORKSPACE_DIR}/glob-filter-test`;
        const marker = 'UNIQUE_SEARCH_MARKER_123';

        await filesWriteFileTool.invoke(
          {
            filePath: `${searchDir}/code.ts`,
            fileContent: `const x = "${marker}";`,
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );
        await filesWriteFileTool.invoke(
          {
            filePath: `${searchDir}/data.json`,
            fileContent: `{"key": "${marker}"}`,
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        // Search only in .ts files
        const { output: tsOnly } = await filesSearchTextTool.invoke(
          {
            searchInDirectory: searchDir,
            textPattern: marker,
            onlyInFilesMatching: ['*.ts'],
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(tsOnly.error).toBeUndefined();
        expect(tsOnly.matches).toHaveLength(1);
        expect(tsOnly.matches![0]!.filePath).toContain('code.ts');
      },
    );

    it(
      'excludes results with skipFilesMatching',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const searchDir = `${WORKSPACE_DIR}/glob-skip-test`;
        const marker = 'SKIP_FILTER_MARKER_456';

        await filesWriteFileTool.invoke(
          {
            filePath: `${searchDir}/main.ts`,
            fileContent: `const val = "${marker}";`,
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );
        await filesWriteFileTool.invoke(
          {
            filePath: `${searchDir}/main.spec.ts`,
            fileContent: `test("${marker}", () => {});`,
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        // Skip spec files
        const { output: noSpecs } = await filesSearchTextTool.invoke(
          {
            searchInDirectory: searchDir,
            textPattern: marker,
            skipFilesMatching: ['*.spec.ts'],
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(noSpecs.error).toBeUndefined();
        expect(noSpecs.matches).toHaveLength(1);
        expect(noSpecs.matches![0]!.filePath).toContain('main.ts');
        expect(noSpecs.matches![0]!.filePath).not.toContain('.spec.');
      },
    );
  });

  describe('files_apply_changes: error cases', () => {
    it(
      'returns helpful error when file does not exist',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const { output: result } = await filesApplyChangesTool.invoke(
          {
            filePath: `${WORKSPACE_DIR}/nonexistent-file-${Date.now()}.ts`,
            oldText: 'some text',
            newText: 'replaced text',
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('File not found');
        expect(result.error).toContain('files_write_file');
      },
    );

    it(
      'rejects no-op when oldText equals newText',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const filePath = await writeSampleFile('noop-test.ts');

        const { output: result } = await filesApplyChangesTool.invoke(
          {
            filePath,
            oldText: 'export function greet',
            newText: 'export function greet',
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('identical');
      },
    );
  });

  describe('files_delete: error cases', () => {
    it(
      'returns error when deleting nonexistent file',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        const { output: result } = await filesDeleteTool.invoke(
          {
            filePath: `${WORKSPACE_DIR}/does-not-exist-${Date.now()}.ts`,
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('File not found');
      },
    );

    it(
      'returns error when trying to delete a directory',
      { timeout: INT_TEST_TIMEOUT },
      async () => {
        // Create a directory by writing a file in it
        const dirPath = `${WORKSPACE_DIR}/dir-delete-test-${Date.now()}`;
        await filesWriteFileTool.invoke(
          {
            filePath: `${dirPath}/dummy.txt`,
            fileContent: 'placeholder',
          },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        // Try to delete the directory itself
        const { output: result } = await filesDeleteTool.invoke(
          { filePath: dirPath },
          { runtimeProvider: runtimeThreadProvider },
          RUNNABLE_CONFIG,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('directory');
      },
    );
  });
});

describe('Files tools graph execution', () => {
  let app: INestApplication;
  let graphsService: GraphsService;
  let threadsService: ThreadsService;
  const createdGraphIds: string[] = [];
  let testProjectId: string;

  const THREAD_STATUSES: ThreadStatus[] = [
    ThreadStatus.Done,
    ThreadStatus.NeedMoreInfo,
    ThreadStatus.Stopped,
  ];

  const SEARCH_DIR = '/runtime-workspace/files-search-graph';
  const SEARCH_QUERY = 'reasoning';
  const INCLUDE_GLOBS = ['**/*.ts', '**/*.tsx', '**/*.txt'];

  const registerGraph = (graphId: string) => {
    if (!createdGraphIds.includes(graphId)) {
      createdGraphIds.push(graphId);
    }
  };

  const cleanupGraph = async (graphId: string) => {
    try {
      await graphsService.destroy(contextDataStorage, graphId);
    } catch (error: unknown) {
      if (
        !(error instanceof BaseException) ||
        (error.errorCode !== 'GRAPH_NOT_FOUND' &&
          error.errorCode !== 'GRAPH_NOT_RUNNING')
      ) {
        throw error;
      }
    }

    try {
      await graphsService.delete(contextDataStorage, graphId);
    } catch (error: unknown) {
      if (
        !(error instanceof BaseException) ||
        error.errorCode !== 'GRAPH_NOT_FOUND'
      ) {
        throw error;
      }
    }
  };

  const waitForGraphStatus = async (
    graphId: string,
    status: GraphStatus,
    timeoutMs = 180_000,
  ) => {
    return waitForCondition(
      () => graphsService.findById(contextDataStorage, graphId),
      (graph) => graph.status === status,
      { timeout: timeoutMs, interval: 1_000 },
    );
  };

  const waitForThreadCompletion = async (
    externalThreadId: string,
    timeoutMs = 120_000,
  ) => {
    const thread = await threadsService.getThreadByExternalId(
      contextDataStorage,
      externalThreadId,
    );

    return waitForCondition(
      () => threadsService.getThreadById(contextDataStorage, thread.id),
      (currentThread) => THREAD_STATUSES.includes(currentThread.status),
      {
        timeout: timeoutMs,
        interval: 1_000,
      },
    );
  };

  const getThreadMessages = async (externalThreadId: string) => {
    const thread = await threadsService.getThreadByExternalId(
      contextDataStorage,
      externalThreadId,
    );
    return threadsService.getThreadMessages(contextDataStorage, thread.id);
  };

  type ToolMessage = Extract<ThreadMessageDto['message'], { role: 'tool' }>;
  const isFileSearchToolMessage = (
    msg: ThreadMessageDto['message'],
  ): msg is ToolMessage & { name?: string; content?: unknown } =>
    msg.role === 'tool' &&
    (msg as { name?: string }).name === 'files_search_text';

  const findFileSearchExecution = (messages: ThreadMessageDto[]) => {
    const toolMessage = messages
      .map((message) => message.message)
      .find((msg) => isFileSearchToolMessage(msg));

    let parsedResult: unknown;
    const content = (toolMessage as { content?: unknown } | undefined)?.content;
    if (content !== undefined) {
      try {
        parsedResult =
          typeof content === 'string' ? JSON.parse(content) : content;
      } catch {
        parsedResult = content;
      }
    }

    return { toolMessage, parsedResult };
  };

  const createFilesSearchGraphData = (): CreateGraphDto => {
    return {
      name: `Files Search Graph ${Date.now()}`,
      description: 'Integration test graph for files_search_text tool',
      temporary: true,
      schema: {
        nodes: [
          {
            id: 'trigger-1',
            template: 'manual-trigger',
            config: {},
          },
          {
            id: 'agent-1',
            template: 'simple-agent',
            config: {
              instructions: `
You are a file search assistant.
When the user message contains 'SEARCH_WITH_FILES_TOOL' followed by JSON, parse that JSON and call files_search_text exactly once with those parameters. After the tool returns, immediately call finish with a short summary of matches. Do not use any other tools.
              `,
              name: 'Files Search Agent',
              description: 'Searches files for a query',
              summarizeMaxTokens: 272000,
              summarizeKeepTokens: 30000,
              invokeModelName: 'gpt-5-mini',
              invokeModelReasoningEffort: ReasoningEffort.None,
              maxIterations: 20,
            } satisfies SimpleAgentSchemaType,
          },
          {
            id: 'files-1',
            template: 'files-tool',
            config: {},
          },
          {
            id: 'runtime-1',
            template: 'runtime',
            config: {
              runtimeType: 'Docker',
              image: environment.dockerRuntimeImage,
              initScript: [
                `mkdir -p ${SEARCH_DIR}/src`,
                `echo "This line has ${SEARCH_QUERY} content." > ${SEARCH_DIR}/src/sample.ts`,
              ],
              initScriptTimeoutMs: 180_000,
            },
          },
        ],
        edges: [
          { from: 'trigger-1', to: 'agent-1' },
          { from: 'agent-1', to: 'files-1' },
          { from: 'files-1', to: 'runtime-1' },
        ],
      },
    };
  };

  beforeAll(async () => {
    app = await createTestModule(async (m) =>
      m
        .overrideProvider(LiteLlmClient)
        .useValue(mockLiteLlmClient)
        .overrideProvider(ThreadNameGeneratorService)
        .useValue(mockThreadNameGenerator)
        .compile(),
    );
    graphsService = app.get<GraphsService>(GraphsService);
    threadsService = app.get<ThreadsService>(ThreadsService);

    const projectResult = await createTestProject(app);
    testProjectId = projectResult.projectId;
    contextDataStorage = projectResult.ctx;
  });

  beforeEach(() => {
    getMockLlm(app).reset();
  });

  afterEach(async () => {
    while (createdGraphIds.length > 0) {
      const graphId = createdGraphIds.pop();
      if (graphId) {
        await cleanupGraph(graphId);
      }
    }
  }, 180_000);

  afterAll(async () => {
    if (testProjectId) {
      try {
        await app.get(ProjectsDao).deleteById(testProjectId);
      } catch {
        // best effort cleanup
      }
    }

    await app.close();
  });

  it(
    'runs files_search_text via graph trigger and returns matches',
    { timeout: 45000 },
    async () => {
      const mockLlm = getMockLlm(app);

      // MockRuntime doesn't run a real `rg` against the simulated workdir;
      // register a fixture that returns the canonical `rg --json` line for the
      // sample file the production initScript would have created.
      const samplePath = `${SEARCH_DIR}/src/sample.ts`;
      const sampleLine = `This line has ${SEARCH_QUERY} content.`;
      const matchOffset = sampleLine.indexOf(SEARCH_QUERY);
      const ripgrepJsonOutput = [
        JSON.stringify({
          type: 'match',
          data: {
            path: { text: samplePath },
            lines: { text: `${sampleLine}\n` },
            line_number: 1,
            absolute_offset: 0,
            submatches: [
              {
                match: { text: SEARCH_QUERY },
                start: matchOffset,
                end: matchOffset + SEARCH_QUERY.length,
              },
            ],
          },
        }),
        '',
      ].join('\n');
      getMockRuntime(app).onExec(
        { cmd: 'rg --json' },
        { exitCode: 0, stdout: ripgrepJsonOutput, stderr: '' },
      );

      // Turn 1 (callIndex 0): files_search_text is not yet loaded — agent uses
      // tool_search to discover it.
      mockLlm.onChat(
        { callIndex: 0 },
        {
          kind: 'toolCall',
          toolName: 'tool_search',
          args: { query: 'search files text' },
        },
      );

      // Turn 2: files_search_text is now loaded — agent calls it with the params
      // extracted from the user message.
      mockLlm.onChat(
        { hasTools: ['files_search_text'] },
        {
          kind: 'toolCall',
          toolName: 'files_search_text',
          args: {
            searchInDirectory: SEARCH_DIR,
            textPattern: SEARCH_QUERY,
            onlyInFilesMatching: INCLUDE_GLOBS,
          },
        },
      );

      // Turn 3: after the files_search_text result arrives, the agent calls finish.
      // Using both hasToolResult + hasTools for specificity 2 so this fixture beats
      // the hasTools-only files_search_text fixture (specificity 1) when the tool
      // result is in context.
      mockLlm.onChat(
        { hasToolResult: 'files_search_text', hasTools: ['finish'] },
        {
          kind: 'toolCall',
          toolName: 'finish',
          args: {
            purpose: 'done',
            message: 'Search completed.',
            needsMoreInfo: false,
          },
        },
      );

      const graph = await graphsService.create(
        contextDataStorage,
        createFilesSearchGraphData(),
      );
      registerGraph(graph.id);

      await graphsService.run(contextDataStorage, graph.id);
      await waitForGraphStatus(graph.id, GraphStatus.Running, 30000);

      const execution = await graphsService.executeTrigger(
        contextDataStorage,
        graph.id,
        'trigger-1',
        {
          messages: [
            `SEARCH_WITH_FILES_TOOL {"dir":"${SEARCH_DIR}","query":"${SEARCH_QUERY}","includeGlobs":${JSON.stringify(
              INCLUDE_GLOBS,
            )}}`,
          ],
          async: false,
        },
      );

      expect(execution.externalThreadId).toBeDefined();

      const thread = await waitForThreadCompletion(execution.externalThreadId);
      expect(THREAD_STATUSES).toContain(thread.status);

      const messages = await getThreadMessages(execution.externalThreadId);
      const searchExecution = findFileSearchExecution(messages);

      if (!searchExecution.toolMessage) {
        throw new Error(
          `files_search_text tool was not invoked. Messages: ${JSON.stringify(
            messages.map((m) => m.message),
          )}`,
        );
      }

      const parsed = searchExecution.parsedResult as
        | { matches?: { filePath?: string }[] }
        | undefined;

      if (!Array.isArray(parsed?.matches) || parsed.matches.length === 0) {
        throw new Error(
          `files_search_text returned no matches. Raw result: ${JSON.stringify(
            searchExecution.parsedResult,
          )}`,
        );
      }

      const firstPath = parsed.matches[0]?.filePath;
      expect(firstPath).toContain('/src/sample.ts');
    },
  );
});
