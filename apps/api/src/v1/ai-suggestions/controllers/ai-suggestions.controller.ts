import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CtxStorage, OnlyForAuthorized } from '@packages/http-server';

import { AppContextStorage } from '../../../auth/app-context-storage';
import {
  KnowledgeContentSuggestionRequestDto,
  KnowledgeContentSuggestionResponseDto,
  SuggestAgentInstructionsDto,
  SuggestAgentInstructionsResponseDto,
  SuggestGraphInstructionsDto,
  SuggestGraphInstructionsResponseDto,
  ThreadAnalysisRequestDto,
  ThreadAnalysisResponseDto,
} from '../dto/ai-suggestions.dto';
import { AiSuggestionsService } from '../services/ai-suggestions.service';

@Controller()
@ApiTags('graphs', 'threads', 'knowledge')
@ApiBearerAuth()
@OnlyForAuthorized()
export class AiSuggestionsController {
  constructor(private readonly aiSuggestionsService: AiSuggestionsService) {}

  @Throttle({ default: { ttl: 60000, limit: 50 } })
  @Post('graphs/:graphId/nodes/:nodeId/suggest-instructions')
  @ApiCreatedResponse({ type: SuggestAgentInstructionsResponseDto })
  async suggestAgentInstructions(
    @Param('graphId') graphId: string,
    @Param('nodeId') nodeId: string,
    @Body() dto: SuggestAgentInstructionsDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<SuggestAgentInstructionsResponseDto> {
    return await this.aiSuggestionsService.suggest(ctx, graphId, nodeId, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 50 } })
  @Post('graphs/:graphId/suggest-instructions')
  @ApiCreatedResponse({ type: SuggestGraphInstructionsResponseDto })
  async suggestGraphInstructions(
    @Param('graphId') graphId: string,
    @Body() dto: SuggestGraphInstructionsDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<SuggestGraphInstructionsResponseDto> {
    return await this.aiSuggestionsService.suggestGraphInstructions(
      ctx,
      graphId,
      dto,
    );
  }

  @Throttle({ default: { ttl: 60000, limit: 50 } })
  @Post('threads/:threadId/analyze')
  @ApiCreatedResponse({ type: ThreadAnalysisResponseDto })
  async analyzeThread(
    @Param('threadId') threadId: string,
    @Body() payload: ThreadAnalysisRequestDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<ThreadAnalysisResponseDto> {
    return this.aiSuggestionsService.analyzeThread(ctx, threadId, payload);
  }

  @Throttle({ default: { ttl: 60000, limit: 50 } })
  @Post('knowledge-docs/suggest')
  @ApiCreatedResponse({ type: KnowledgeContentSuggestionResponseDto })
  async suggestKnowledgeContent(
    @Body() payload: KnowledgeContentSuggestionRequestDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<KnowledgeContentSuggestionResponseDto> {
    return this.aiSuggestionsService.suggestKnowledgeContent(ctx, payload);
  }
}
