import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CtxStorage, OnlyForAuthorized } from '@packages/http-server';

import { AppContextStorage } from '../../../auth/app-context-storage';
import {
  CreateRepositoryDto,
  GetRepoIndexesQueryDto,
  GetRepositoriesQueryDto,
  GitRepositoryDto,
  RepoIndexDto,
  SyncRepositoriesResponseDto,
  TriggerReindexDto,
  TriggerReindexResponseDto,
  UpdateRepositoryDto,
} from '../dto/git-repositories.dto';
import { GitRepositoriesService } from '../services/git-repositories.service';

@ApiTags('git-repositories')
@Controller('git-repositories')
@ApiBearerAuth()
@OnlyForAuthorized()
export class GitRepositoriesController {
  constructor(
    private readonly gitRepositoriesService: GitRepositoriesService,
  ) {}

  @Post()
  async createRepository(
    @Body() dto: CreateRepositoryDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<GitRepositoryDto> {
    return this.gitRepositoriesService.createRepository(
      contextDataStorage,
      dto,
    );
  }

  @Get()
  async getRepositories(
    @Query() query: GetRepositoriesQueryDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<GitRepositoryDto[]> {
    return this.gitRepositoriesService.getRepositories(
      contextDataStorage,
      query,
    );
  }

  // Static routes MUST be declared before parameterised routes so that
  // NestJS matches them first (e.g. GET /indexes before GET /:id).
  @Get('indexes')
  async getRepoIndexes(
    @Query() query: GetRepoIndexesQueryDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<RepoIndexDto[]> {
    return this.gitRepositoriesService.getRepoIndexes(
      contextDataStorage,
      query,
    );
  }

  @Post('sync')
  async syncRepositories(
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<SyncRepositoriesResponseDto> {
    return this.gitRepositoriesService.syncRepositories(ctx);
  }

  @Get(':id')
  async getRepositoryById(
    @Param('id') id: string,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<GitRepositoryDto> {
    return this.gitRepositoriesService.getRepositoryById(
      contextDataStorage,
      id,
    );
  }

  @Get(':id/index')
  @ApiQuery({
    name: 'branch',
    required: false,
    type: String,
    description: 'Optional branch name to filter repo indexes',
  })
  async getRepoIndexByRepositoryId(
    @Param('id') id: string,
    @Query('branch') branch: string | undefined,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<RepoIndexDto | null> {
    return this.gitRepositoriesService.getRepoIndexByRepositoryId(
      contextDataStorage,
      id,
      branch,
    );
  }

  @Patch(':id')
  async updateRepository(
    @Param('id') id: string,
    @Body() dto: UpdateRepositoryDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<GitRepositoryDto> {
    return this.gitRepositoriesService.updateRepository(
      contextDataStorage,
      id,
      dto,
    );
  }

  @Delete(':id')
  async deleteRepository(
    @Param('id') id: string,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<void> {
    return this.gitRepositoriesService.deleteRepository(contextDataStorage, id);
  }

  @Post('reindex')
  async triggerReindex(
    @Body() dto: TriggerReindexDto,
    @CtxStorage() contextDataStorage: AppContextStorage,
  ): Promise<TriggerReindexResponseDto> {
    return this.gitRepositoriesService.triggerReindex(contextDataStorage, dto);
  }
}
