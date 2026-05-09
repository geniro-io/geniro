import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CtxStorage, OnlyForAuthorized } from '@packages/http-server';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { EntityUUIDDto } from '../../../utils/dto/misc.dto';
import {
  KnowledgeDocCreateDto,
  KnowledgeDocDto,
  KnowledgeDocListQueryDto,
  KnowledgeDocListResultDto,
  KnowledgeDocUpdateDto,
} from '../dto/knowledge.dto';
import {
  KnowledgeDocListResult,
  KnowledgeService,
} from '../services/knowledge.service';

@ApiTags('knowledge')
@Controller('knowledge-docs')
@ApiBearerAuth()
@OnlyForAuthorized()
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Post()
  @ApiCreatedResponse({ type: KnowledgeDocDto })
  async createDoc(
    @Body() dto: KnowledgeDocCreateDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<KnowledgeDocDto> {
    return this.knowledgeService.createDoc(contextDataStorage, dto);
  }

  @Put(':id')
  @ApiOkResponse({ type: KnowledgeDocDto })
  async updateDoc(
    @Param() params: EntityUUIDDto,
    @Body() dto: KnowledgeDocUpdateDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<KnowledgeDocDto> {
    return this.knowledgeService.updateDoc(contextDataStorage, params.id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async deleteDoc(
    @Param() params: EntityUUIDDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<void> {
    await this.knowledgeService.deleteDoc(contextDataStorage, params.id);
  }

  @Get()
  @ApiOkResponse({ type: KnowledgeDocListResultDto })
  async listDocs(
    @Query() query: KnowledgeDocListQueryDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<KnowledgeDocListResult> {
    return this.knowledgeService.listDocs(contextDataStorage, query);
  }

  @Get(':id')
  @ApiOkResponse({ type: KnowledgeDocDto })
  async getDoc(
    @Param() params: EntityUUIDDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<KnowledgeDocDto> {
    return this.knowledgeService.getDoc(contextDataStorage, params.id);
  }
}
