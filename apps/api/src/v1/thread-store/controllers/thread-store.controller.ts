import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { NotFoundException } from '@packages/common';
import { CtxStorage, OnlyForAuthorized } from '@packages/http-server';

import { AppContextStorage } from '../../../auth/app-context-storage';
import {
  keySchema,
  ListEntriesQueryDto,
  namespaceSchema,
  NamespaceSummaryDto,
  ThreadStoreEntryDto,
} from '../dto/thread-store.dto';
import { ThreadStoreService } from '../services/thread-store.service';

@ApiTags('thread-store')
@Controller('threads/:threadId/store')
@ApiBearerAuth()
@OnlyForAuthorized()
export class ThreadStoreController {
  constructor(private readonly threadStoreService: ThreadStoreService) {}

  @Throttle({ default: { ttl: 60000, limit: 50 } })
  @ApiOkResponse({ type: NamespaceSummaryDto, isArray: true })
  @Get()
  async listNamespaces(
    @Param('threadId') threadId: string,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<NamespaceSummaryDto[]> {
    return this.threadStoreService.listNamespaces(ctx, threadId);
  }

  @Throttle({ default: { ttl: 60000, limit: 50 } })
  @ApiOkResponse({ type: ThreadStoreEntryDto, isArray: true })
  @Get(':namespace')
  async listEntries(
    @Param('threadId') threadId: string,
    @Param('namespace') namespace: string,
    @Query() query: ListEntriesQueryDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<ThreadStoreEntryDto[]> {
    const validatedNamespace = namespaceSchema.parse(namespace);
    return this.threadStoreService.listEntries(
      ctx,
      threadId,
      validatedNamespace,
      query,
    );
  }

  @Throttle({ default: { ttl: 60000, limit: 50 } })
  @ApiOkResponse({ type: ThreadStoreEntryDto })
  @Get(':namespace/:key')
  async getEntry(
    @Param('threadId') threadId: string,
    @Param('namespace') namespace: string,
    @Param('key') key: string,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<ThreadStoreEntryDto> {
    const validatedNamespace = namespaceSchema.parse(namespace);
    const validatedKey = keySchema.parse(key);
    const entry = await this.threadStoreService.get(
      ctx,
      threadId,
      validatedNamespace,
      validatedKey,
    );
    if (!entry) {
      throw new NotFoundException('THREAD_STORE_ENTRY_NOT_FOUND');
    }
    return entry;
  }
}
