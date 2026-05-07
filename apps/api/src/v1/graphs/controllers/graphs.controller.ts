import {
  Body,
  Controller,
  Delete,
  Get,
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
import { Throttle } from '@nestjs/throttler';
import { CtxStorage, OnlyForAuthorized } from '@packages/http-server';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { EntityUUIDDto } from '../../../utils/dto/misc.dto';
import {
  CreateGraphDto,
  ExecuteTriggerDto,
  ExecuteTriggerResponseDto,
  GetAllGraphsQueryDto,
  GetGraphsPreviewQueryDto,
  GraphDto,
  GraphNodesQueryDto,
  GraphNodeWithStatusDto,
  GraphPreviewDto,
  UpdateGraphDto,
  UpdateGraphResponseDto,
} from '../dto/graphs.dto';
import { GraphsService } from '../services/graphs.service';

@Controller('graphs')
@ApiTags('graphs')
@ApiBearerAuth()
@OnlyForAuthorized()
export class GraphsController {
  constructor(private readonly graphsService: GraphsService) {}

  @Post()
  @ApiCreatedResponse({ type: GraphDto })
  async createGraph(
    @Body() dto: CreateGraphDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<GraphDto> {
    return await this.graphsService.create(contextDataStorage, dto);
  }

  @Get()
  @ApiOkResponse({ type: GraphDto, isArray: true })
  async getAllGraphs(
    @Query() query: GetAllGraphsQueryDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<GraphDto[]> {
    return await this.graphsService.getAll(contextDataStorage, query);
  }

  @Get('preview')
  @ApiOkResponse({ type: GraphPreviewDto, isArray: true })
  async getGraphsPreview(
    @Query() query: GetGraphsPreviewQueryDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<GraphPreviewDto[]> {
    return await this.graphsService.getGraphsPreview(contextDataStorage, query);
  }

  @Get(':id')
  @ApiOkResponse({ type: GraphDto })
  async findGraphById(
    @Param() params: EntityUUIDDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<GraphDto> {
    return await this.graphsService.findById(contextDataStorage, params.id);
  }

  @Get(':id/nodes')
  @ApiOkResponse({ type: GraphNodeWithStatusDto, isArray: true })
  async getCompiledNodes(
    @Param() params: EntityUUIDDto,
    @Query() query: GraphNodesQueryDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<GraphNodeWithStatusDto[]> {
    return this.graphsService.getCompiledNodes(
      contextDataStorage,
      params.id,
      query,
    );
  }

  @Put(':id')
  @ApiOkResponse({ type: UpdateGraphResponseDto })
  async updateGraph(
    @Param() params: EntityUUIDDto,
    @Body() dto: UpdateGraphDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<UpdateGraphResponseDto> {
    return await this.graphsService.update(contextDataStorage, params.id, dto);
  }

  @Delete(':id')
  async deleteGraph(
    @Param() params: EntityUUIDDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<void> {
    await this.graphsService.delete(contextDataStorage, params.id);
  }

  @Throttle({ default: { ttl: 60000, limit: 50 } })
  @Post(':id/run')
  @ApiCreatedResponse({ type: GraphDto })
  async runGraph(
    @Param() params: EntityUUIDDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<GraphDto> {
    return await this.graphsService.run(contextDataStorage, params.id);
  }

  @Post(':id/destroy')
  @ApiCreatedResponse({ type: GraphDto })
  async destroyGraph(
    @Param() params: EntityUUIDDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<GraphDto> {
    return await this.graphsService.destroy(contextDataStorage, params.id);
  }

  @Throttle({ default: { ttl: 60000, limit: 50 } })
  @Post(':graphId/triggers/:triggerId/execute')
  @ApiCreatedResponse({ type: ExecuteTriggerResponseDto })
  async executeTrigger(
    @Param('graphId') graphId: string,
    @Param('triggerId') triggerId: string,
    @Body() payload: ExecuteTriggerDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<ExecuteTriggerResponseDto> {
    return await this.graphsService.executeTrigger(
      contextDataStorage,
      graphId,
      triggerId,
      payload,
    );
  }
}
