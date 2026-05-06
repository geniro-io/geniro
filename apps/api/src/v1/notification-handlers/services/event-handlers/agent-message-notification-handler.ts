import { Injectable } from '@nestjs/common';

import type { MessageAdditionalKwargs } from '../../../agents/agents.types';
import { GraphDao } from '../../../graphs/dao/graph.dao';
import { MessageRole } from '../../../graphs/graphs.types';
import { MessageTransformerService } from '../../../graphs/services/message-transformer.service';
import type { RequestTokenUsage } from '../../../litellm/litellm.types';
import {
  IAgentMessageNotification,
  NotificationEvent,
} from '../../../notifications/notifications.types';
import { MessagesDao } from '../../../threads/dao/messages.dao';
import { ThreadsDao } from '../../../threads/dao/threads.dao';
import {
  ThreadMessageDto,
  ThreadMessageSchema,
} from '../../../threads/dto/threads.dto';
import {
  IEnrichedNotification,
  NotificationScope,
} from '../../notification-handlers.types';
import { BaseNotificationHandler } from './base-notification-handler';

export interface IAgentMessageEnrichedNotification extends IEnrichedNotification<ThreadMessageDto> {
  type: NotificationEvent.AgentMessage;
  nodeId: string;
  threadId: string;
  internalThreadId: string;
}

@Injectable()
export class AgentMessageNotificationHandler extends BaseNotificationHandler<IAgentMessageEnrichedNotification> {
  readonly pattern = NotificationEvent.AgentMessage;

  constructor(
    private readonly graphDao: GraphDao,
    private readonly messageTransformer: MessageTransformerService,
    private readonly messagesDao: MessagesDao,
    private readonly threadsDao: ThreadsDao,
  ) {
    super();
  }

  async handle(
    event: IAgentMessageNotification,
  ): Promise<IAgentMessageEnrichedNotification[]> {
    const { ownerId, projectId } = await this.getGraphInfo(
      this.graphDao,
      event.graphId,
    );
    const out: IAgentMessageEnrichedNotification[] = [];

    const externalThreadKey = event.parentThreadId ?? event.threadId;

    // Find the internal thread by internalThreadId passed from the event
    const internalThread = await this.threadsDao.getOne({
      externalThreadId: externalThreadKey,
    });

    if (!internalThread) {
      // Internal thread not found, skip message storage
      // This shouldn't happen if agent-invoke-notification-handler works correctly
      return out;
    }

    // Transform BaseMessage array
    const messageDtos = this.messageTransformer.transformMessagesToDto(
      event.data.messages,
    );

    // Prepare all messages for batch insert
    const messagesToCreate = messageDtos.map((messageDto, i) => {
      const originalMessage = event.data.messages[i];
      const additionalKwargs = originalMessage?.additional_kwargs as
        | MessageAdditionalKwargs
        | undefined;

      // Extract request-level token usage (full RequestTokenUsage from LLM request).
      // Saved for ALL AI messages — including subagent internal ones.
      // Tool messages carry __requestUsage from their parent AI message (set by ToolExecutorNode),
      // but storing it would double-count the same LLM call.
      const requestTokenUsage =
        messageDto.role === MessageRole.AI
          ? (additionalKwargs?.__requestUsage as RequestTokenUsage | undefined)
          : undefined;

      // Extract tool call names and IDs for AI messages with tool calls
      const toolCalls =
        messageDto.role === MessageRole.AI &&
        Array.isArray(messageDto.toolCalls) &&
        messageDto.toolCalls.length > 0
          ? messageDto.toolCalls
          : undefined;

      const toolCallNames = toolCalls
        ?.map((tc) => tc.name)
        .filter((name): name is string => typeof name === 'string');

      const toolCallIds = toolCalls
        ?.map((tc) => tc.id)
        .filter((id): id is string => typeof id === 'string');

      // Extract tool's own execution token usage (e.g. subagent aggregate tokens)
      const toolTokenUsage = additionalKwargs?.__toolTokenUsage as
        | RequestTokenUsage
        | undefined;

      // Subagent messages are stored under a surrogate nodeId so that per-node
      // cost queries can distinguish subagent invocations from the parent node.
      // Both signals must be present; a missing __toolCallId falls back to the
      // parent event.nodeId to avoid malformed composite keys.
      const isSubagentMessage =
        additionalKwargs?.__subagentCommunication === true &&
        typeof additionalKwargs?.__toolCallId === 'string' &&
        additionalKwargs.__toolCallId.length > 0;
      const persistedNodeId = isSubagentMessage
        ? `${event.nodeId}::sub::${additionalKwargs!.__toolCallId as string}`
        : event.nodeId;

      return {
        threadId: internalThread.id,
        externalThreadId: event.threadId,
        nodeId: persistedNodeId,
        message: messageDto,
        // Store requestTokenUsage if present (all AI messages, including subagent internals)
        ...(requestTokenUsage ? { requestTokenUsage } : {}),
        // Denormalize role, name, toolCallNames, and toolCallIds for query performance
        role: messageDto.role,
        name: 'name' in messageDto ? (messageDto.name as string) : undefined,
        ...(toolCallNames && toolCallNames.length > 0 ? { toolCallNames } : {}),
        ...(toolCallIds && toolCallIds.length > 0 ? { toolCallIds } : {}),
        answeredToolCallNames: Array.isArray(
          additionalKwargs?.__answeredToolCallNames,
        )
          ? (additionalKwargs.__answeredToolCallNames as string[])
          : undefined,
        // Denormalize additionalKwargs for statistics queries (avoids fetching full message JSONB).
        // Strip __requestUsage and __toolTokenUsage — both stored in dedicated columns.
        additionalKwargs: additionalKwargs
          ? this.stripRedundantUsageFields(
              additionalKwargs as Record<string, unknown>,
            )
          : undefined,
        // Tool's own execution cost (e.g. subagent aggregate tokens)
        ...(toolTokenUsage ? { toolTokenUsage } : {}),
      };
    });

    const createdMessages =
      messagesToCreate.length > 0
        ? await this.messagesDao.createMany(messagesToCreate)
        : [];

    // Build notification events for each created message
    for (const createdMessage of createdMessages) {
      out.push({
        type: NotificationEvent.AgentMessage,
        graphId: event.graphId,
        projectId,
        ownerId,
        nodeId: event.nodeId,
        threadId: event.threadId,
        internalThreadId: internalThread.id,
        scope: [NotificationScope.Graph],
        data: ThreadMessageSchema.parse({
          ...createdMessage,
          createdAt: new Date(createdMessage.createdAt).toISOString(),
          updatedAt: new Date(createdMessage.updatedAt).toISOString(),
        }),
      });
    }

    return out;
  }

  /**
   * Strip fields already stored in dedicated columns to avoid redundant data
   * in the additionalKwargs JSONB.  Both __requestUsage and __toolTokenUsage
   * have their own columns on the message entity.
   */
  private stripRedundantUsageFields(
    kwargs: Record<string, unknown>,
  ): Record<string, unknown> {
    const stripped = { ...kwargs };
    delete stripped.__requestUsage;
    delete stripped.__toolTokenUsage;
    return stripped;
  }
}
