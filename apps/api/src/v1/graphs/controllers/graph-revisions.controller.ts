import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CtxStorage, OnlyForAuthorized } from '@packages/http-server';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { EntityUUIDDto } from '../../../utils/dto/misc.dto';
import {
  GraphRevisionDto,
  GraphRevisionQueryDto,
} from '../dto/graph-revisions.dto';
import { GraphRevisionService } from '../services/graph-revision.service';

@Controller('graphs/:graphId/revisions')
@ApiTags('graph-revisions')
@ApiBearerAuth()
@OnlyForAuthorized()
export class GraphRevisionsController {
  constructor(private readonly graphRevisionService: GraphRevisionService) {}

  @Get()
  @ApiOkResponse({ type: GraphRevisionDto, isArray: true })
  async getGraphRevisions(
    @Param('graphId') graphId: string,
    @Query() query: GraphRevisionQueryDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<GraphRevisionDto[]> {
    return await this.graphRevisionService.getRevisions(
      contextDataStorage,
      graphId,
      query,
    );
  }

  @Get(':id')
  @ApiOkResponse({ type: GraphRevisionDto })
  async getGraphRevision(
    @Param('graphId') graphId: string,
    @Param() params: EntityUUIDDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<GraphRevisionDto> {
    return await this.graphRevisionService.getRevisionById(
      contextDataStorage,
      graphId,
      params.id,
    );
  }
}
