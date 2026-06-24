import { Body, Controller, Delete, Get, HttpCode, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CtxStorage, OnlyForAuthorized } from '@packages/http-server';

import { AppContextStorage } from '../../../auth/app-context-storage';
import {
  GitUserPatStatusResponseDto,
  SetGitUserPatRequestDto,
} from '../dto/git-auth.dto';
import { GitUserPatService } from '../services/git-user-pat.service';

@ApiTags('git-auth')
@Controller('git-auth/pat')
export class GitUserPatController {
  constructor(private readonly gitUserPatService: GitUserPatService) {}

  @Get()
  @ApiBearerAuth()
  @OnlyForAuthorized()
  @ApiOkResponse({ type: GitUserPatStatusResponseDto })
  async getStatus(
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<GitUserPatStatusResponseDto> {
    return this.gitUserPatService.getStatus(ctx);
  }

  @Put()
  @ApiBearerAuth()
  @OnlyForAuthorized()
  @ApiOkResponse({ type: GitUserPatStatusResponseDto })
  async setPat(
    @Body() body: SetGitUserPatRequestDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<GitUserPatStatusResponseDto> {
    return this.gitUserPatService.putPat(ctx, body.token);
  }

  @Delete()
  @ApiBearerAuth()
  @OnlyForAuthorized()
  @ApiNoContentResponse()
  @HttpCode(204)
  async deletePat(@CtxStorage() ctx: AppContextStorage): Promise<void> {
    await this.gitUserPatService.deletePat(ctx);
  }
}
