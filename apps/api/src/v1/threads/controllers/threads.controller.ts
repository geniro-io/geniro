import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CtxStorage, OnlyForAuthorized } from '@packages/http-server';

import { AppContextStorage } from '../../../auth/app-context-storage';
import {
  GetMessagesQueryDto,
  GetThreadsQueryDto,
  ResumeThreadDto,
  SetThreadMetadataDto,
  ThreadDto,
  ThreadMessageDto,
  ThreadUsageStatisticsDto,
} from '../dto/threads.dto';
import { ThreadsService } from '../services/threads.service';

@ApiTags('threads')
@Controller('threads')
@ApiBearerAuth()
@OnlyForAuthorized()
export class ThreadsController {
  constructor(private readonly threadsService: ThreadsService) {}

  @Get()
  @ApiOkResponse({ type: ThreadDto, isArray: true })
  async getThreads(
    @Query() query: GetThreadsQueryDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<ThreadDto[]> {
    return this.threadsService.getThreads(ctx, query);
  }

  @Get(':threadId')
  @ApiOkResponse({ type: ThreadDto })
  async getThreadById(
    @Param('threadId') threadId: string,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<ThreadDto> {
    return this.threadsService.getThreadById(ctx, threadId);
  }

  @Get('external/:externalThreadId')
  @ApiOkResponse({ type: ThreadDto })
  async getThreadByExternalId(
    @Param('externalThreadId') externalThreadId: string,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<ThreadDto> {
    return this.threadsService.getThreadByExternalId(ctx, externalThreadId);
  }

  @Get(':threadId/messages')
  @ApiOkResponse({ type: ThreadMessageDto, isArray: true })
  async getThreadMessages(
    @Param('threadId') threadId: string,
    @Query() query: GetMessagesQueryDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<ThreadMessageDto[]> {
    return this.threadsService.getThreadMessages(ctx, threadId, query);
  }

  @Get(':threadId/usage-statistics')
  @ApiOkResponse({ type: ThreadUsageStatisticsDto })
  async getThreadUsageStatistics(
    @Param('threadId') threadId: string,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<ThreadUsageStatisticsDto> {
    return this.threadsService.getThreadUsageStatistics(ctx, threadId);
  }

  @Get(':threadId/export')
  @ApiOkResponse({ description: 'Thread export as a downloadable file.' })
  async exportThread(
    @Param('threadId') threadId: string,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<StreamableFile> {
    return this.threadsService.getThreadExportFile(ctx, threadId);
  }

  @Put(':threadId/metadata')
  @ApiOkResponse({ type: ThreadDto })
  async setThreadMetadata(
    @Param('threadId') threadId: string,
    @Body() dto: SetThreadMetadataDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<ThreadDto> {
    return this.threadsService.setMetadata(ctx, threadId, dto);
  }

  @Put('external/:externalThreadId/metadata')
  @ApiOkResponse({ type: ThreadDto })
  async setThreadMetadataByExternalId(
    @Param('externalThreadId') externalThreadId: string,
    @Body() dto: SetThreadMetadataDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<ThreadDto> {
    return this.threadsService.setMetadataByExternalId(
      ctx,
      externalThreadId,
      dto,
    );
  }

  @Delete(':threadId')
  async deleteThread(
    @Param('threadId') threadId: string,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<void> {
    return this.threadsService.deleteThread(ctx, threadId);
  }

  @Post(':threadId/stop')
  @ApiCreatedResponse({ type: ThreadDto })
  async stopThread(
    @Param('threadId') threadId: string,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<ThreadDto> {
    return this.threadsService.stopThread(ctx, threadId);
  }

  @Post('external/:externalThreadId/stop')
  @ApiCreatedResponse({ type: ThreadDto })
  async stopThreadByExternalId(
    @Param('externalThreadId') externalThreadId: string,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<ThreadDto> {
    return this.threadsService.stopThreadByExternalId(ctx, externalThreadId);
  }

  @Post(':threadId/resume')
  @ApiCreatedResponse({ type: ThreadDto })
  async resumeThread(
    @Param('threadId') threadId: string,
    @Body() dto: ResumeThreadDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<ThreadDto> {
    return this.threadsService.resumeThread(ctx, threadId, dto);
  }

  @Post(':threadId/cancel-wait')
  @ApiCreatedResponse({ type: ThreadDto })
  async cancelWait(
    @Param('threadId') threadId: string,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<ThreadDto> {
    return this.threadsService.cancelWait(ctx, threadId);
  }
}
