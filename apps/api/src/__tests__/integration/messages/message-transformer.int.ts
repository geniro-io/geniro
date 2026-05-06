import { ToolMessage } from '@langchain/core/messages';
import { INestApplication } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { GraphDao } from '../../../v1/graphs/dao/graph.dao';
import { ToolMessageDto } from '../../../v1/graphs/dto/graphs.dto';
import { GraphStatus } from '../../../v1/graphs/graphs.types';
import { MessageTransformerService } from '../../../v1/graphs/services/message-transformer.service';
import { ProjectsDao } from '../../../v1/projects/dao/projects.dao';
import { MessagesDao } from '../../../v1/threads/dao/messages.dao';
import { ThreadsDao } from '../../../v1/threads/dao/threads.dao';
import { ThreadMessageDto } from '../../../v1/threads/dto/threads.dto';
import { ThreadsService } from '../../../v1/threads/services/threads.service';
import { ThreadStatus } from '../../../v1/threads/threads.types';
import { getMockLlm } from '../mocks/mock-llm';
import { createTestModule, TEST_USER_ID } from '../setup';

const EMPTY_REQUEST = { headers: {} } as FastifyRequest;

const contextDataStorage = new AppContextStorage(
  { sub: TEST_USER_ID },
  EMPTY_REQUEST,
);

describe('Message transformer integration', () => {
  let app: INestApplication;
  let messageTransformer: MessageTransformerService;
  let threadsDao: ThreadsDao;
  let messagesDao: MessagesDao;
  let threadsService: ThreadsService;
  let graphDao: GraphDao;
  let projectsDao: ProjectsDao;
  let createdThreadId: string;
  let createdGraphId: string;
  let testProjectId: string;

  beforeAll(async () => {
    app = await createTestModule();
    messageTransformer = app.get<MessageTransformerService>(
      MessageTransformerService,
    );
    threadsDao = app.get<ThreadsDao>(ThreadsDao);
    messagesDao = app.get<MessagesDao>(MessagesDao);
    threadsService = app.get<ThreadsService>(ThreadsService);
    graphDao = app.get<GraphDao>(GraphDao);
    projectsDao = app.get<ProjectsDao>(ProjectsDao);

    const project = await projectsDao.create({
      name: 'Web Search Tool Test Project',
      createdBy: TEST_USER_ID,
      settings: {},
    });
    testProjectId = project.id;

    const graph = await graphDao.create({
      name: 'web-search-tool-test-graph',
      description: 'Integration test graph for web search tool',
      error: undefined,
      version: '1.0.0',
      targetVersion: '1.0.0',
      schema: { nodes: [], edges: [] },
      status: GraphStatus.Created,
      metadata: {},
      createdBy: TEST_USER_ID,
      projectId: testProjectId,
      temporary: true,
    });
    createdGraphId = graph.id;

    const thread = await threadsDao.create({
      graphId: createdGraphId,
      createdBy: TEST_USER_ID,
      projectId: testProjectId,
      externalThreadId: `ext-${Date.now()}`,
      status: ThreadStatus.Running,
      metadata: {},
      source: undefined,
    });

    createdThreadId = thread.id;
  });

  afterAll(async () => {
    if (createdThreadId) {
      await messagesDao.hardDelete({ threadId: createdThreadId });
      await threadsDao.hardDeleteById(createdThreadId);
    }
    if (createdGraphId) {
      await graphDao.deleteById(createdGraphId);
    }
    if (testProjectId) {
      await projectsDao.deleteById(testProjectId);
    }

    await app.close();
  });

  beforeEach(() => {
    getMockLlm(app).reset();
  });

  it('stores tool call title from metadata in message DTO and DB', async () => {
    const title = 'Search in internet: cats';
    const toolMsg = new ToolMessage({
      content: JSON.stringify({ result: 'ok' }),
      name: 'web_search',
      tool_call_id: 'call-1',
      additional_kwargs: { __title: title },
    });

    const dto = messageTransformer.transformMessageToDto(toolMsg);
    expect(dto.role).toBe('tool');
    const toolDto = dto as ToolMessageDto;
    expect(toolDto.title).toBe(title);
    expect(toolDto.additionalKwargs?.__title).toBe(title);

    await messagesDao.create({
      threadId: createdThreadId,
      externalThreadId: 'ext-unused',
      nodeId: 'agent-1',
      message: dto,
    });

    const messages = await threadsService.getThreadMessages(
      contextDataStorage,
      createdThreadId,
    );
    const storedTool = messages.find(
      (m: ThreadMessageDto) =>
        m.message.role === 'tool' && m.message.name === 'web_search',
    );

    expect(storedTool).toBeDefined();
    if (!storedTool) {
      throw new Error('Expected storedTool to be defined');
    }
    expect(storedTool.message.role).toBe('tool');
    const storedToolMessage = storedTool.message as ToolMessageDto;
    expect(storedToolMessage.title).toBe(title);
    expect(storedToolMessage.additionalKwargs?.__title).toBe(title);
  });
});
