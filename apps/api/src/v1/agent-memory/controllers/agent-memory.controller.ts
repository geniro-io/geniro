import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { NotFoundException } from '@packages/common';
import { CtxStorage, OnlyForAuthorized } from '@packages/http-server';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { environment } from '../../../environments';
import {
  AgentMemoryEntryDto,
  keySchema,
  ListEntriesQueryDto,
  namespaceSchema,
  NamespaceSummaryDto,
  SaveEntryBodyDto,
  SearchMemoryQueryDto,
} from '../dto/agent-memory.dto';
import { AgentMemoryService } from '../services/agent-memory.service';

/**
 * Project-scoped durable agent memory. The project is resolved from the
 * `X-Project-Id` header via `ctx.checkProjectId()` — there is no `:projectId`
 * path param. Memory is a shared project resource (not per-user), so reads are
 * scoped by project only.
 */
@ApiTags('agent-memory')
@Controller('memory')
@ApiBearerAuth()
@OnlyForAuthorized()
export class AgentMemoryController {
  constructor(private readonly agentMemoryService: AgentMemoryService) {}

  @Throttle({ default: { ttl: 60000, limit: 50 } })
  @ApiOperation({ operationId: 'listMemoryNamespaces' })
  @ApiOkResponse({ type: NamespaceSummaryDto, isArray: true })
  @Get()
  async listNamespaces(
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<NamespaceSummaryDto[]> {
    return this.agentMemoryService.listNamespaces(ctx);
  }

  @Throttle({ default: { ttl: 60000, limit: 50 } })
  @ApiOperation({ operationId: 'saveMemoryEntry' })
  @ApiOkResponse({ type: AgentMemoryEntryDto })
  @Put()
  async save(
    @Body() body: SaveEntryBodyDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<AgentMemoryEntryDto> {
    return this.agentMemoryService.put(ctx, {
      namespace: body.namespace,
      key: body.key,
      title: body.title ?? null,
      value: body.value,
      tags: body.tags ?? null,
    });
  }

  @Throttle({ default: { ttl: 60000, limit: 50 } })
  @ApiOperation({ operationId: 'searchMemoryEntries' })
  @ApiOkResponse({ type: AgentMemoryEntryDto, isArray: true })
  // Declared before `:namespace` so the static `search` path is unambiguous.
  @Get('search')
  async searchEntries(
    @Query() query: SearchMemoryQueryDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<AgentMemoryEntryDto[]> {
    return this.agentMemoryService.searchEntries(
      ctx,
      query.query,
      query.limit ?? environment.agentMemorySearchDefaultLimit,
    );
  }

  @Throttle({ default: { ttl: 60000, limit: 50 } })
  @ApiOperation({ operationId: 'listMemoryEntries' })
  @ApiOkResponse({ type: AgentMemoryEntryDto, isArray: true })
  @Get(':namespace')
  async listEntries(
    @Param('namespace') namespace: string,
    @Query() query: ListEntriesQueryDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<AgentMemoryEntryDto[]> {
    const validatedNamespace = namespaceSchema.parse(namespace);
    return this.agentMemoryService.listEntries(ctx, validatedNamespace, query);
  }

  @Throttle({ default: { ttl: 60000, limit: 50 } })
  @ApiOperation({ operationId: 'getMemoryEntry' })
  @ApiOkResponse({ type: AgentMemoryEntryDto })
  @Get(':namespace/:key')
  async getEntry(
    @Param('namespace') namespace: string,
    @Param('key') key: string,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<AgentMemoryEntryDto> {
    const validatedNamespace = namespaceSchema.parse(namespace);
    const validatedKey = keySchema.parse(key);
    const entry = await this.agentMemoryService.get(
      ctx,
      validatedNamespace,
      validatedKey,
    );
    if (!entry) {
      throw new NotFoundException('AGENT_MEMORY_ENTRY_NOT_FOUND');
    }
    return entry;
  }

  @Throttle({ default: { ttl: 60000, limit: 50 } })
  @ApiOperation({ operationId: 'deleteMemoryEntry' })
  @HttpCode(204)
  @Delete(':namespace/:key')
  async deleteEntry(
    @Param('namespace') namespace: string,
    @Param('key') key: string,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<void> {
    const validatedNamespace = namespaceSchema.parse(namespace);
    const validatedKey = keySchema.parse(key);
    await this.agentMemoryService.delete(ctx, validatedNamespace, validatedKey);
  }
}
