import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { BadRequestException } from '@packages/common';
import { CtxStorage, OnlyForAuthorized } from '@packages/http-server';

import { AppContextStorage } from '../../../auth/app-context-storage';
import {
  LinkInstallationResponseDto,
  ListInstallationsResponseDto,
  OAuthLinkRequestDto,
  SetupInfoResponseDto,
  UnlinkInstallationResponseDto,
} from '../dto/git-auth.dto';
import { GitHubAppProviderService } from '../services/github-app-provider.service';

@ApiTags('git-auth')
@Controller('git-auth/github')
export class GitHubAuthController {
  constructor(
    private readonly gitHubAppProviderService: GitHubAppProviderService,
  ) {}

  @Get('setup')
  @ApiBearerAuth()
  @OnlyForAuthorized()
  @ApiOkResponse({ type: SetupInfoResponseDto })
  async getSetupInfo(): Promise<SetupInfoResponseDto> {
    return this.gitHubAppProviderService.getSetupInfo();
  }

  @Post('oauth/link')
  @ApiBearerAuth()
  @OnlyForAuthorized()
  @ApiCreatedResponse({ type: LinkInstallationResponseDto })
  async linkViaOAuthCode(
    @Body() body: OAuthLinkRequestDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<LinkInstallationResponseDto> {
    const userId = ctx.checkSub();
    return this.gitHubAppProviderService.linkViaOAuthCode(
      userId,
      body.code,
      body.installationId,
    );
  }

  @Get('installations')
  @ApiBearerAuth()
  @OnlyForAuthorized()
  @ApiOkResponse({ type: ListInstallationsResponseDto })
  async listInstallations(
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<ListInstallationsResponseDto> {
    const userId = ctx.checkSub();
    return this.gitHubAppProviderService.listInstallations(userId);
  }

  @Delete('installations/:installationId')
  @ApiBearerAuth()
  @OnlyForAuthorized()
  @ApiOkResponse({ type: UnlinkInstallationResponseDto })
  async unlinkInstallation(
    @Param('installationId') installationIdParam: string,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<UnlinkInstallationResponseDto> {
    const userId = ctx.checkSub();
    const installationId = Number(installationIdParam);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new BadRequestException(
        'INVALID_INSTALLATION_ID',
        'installationId must be a positive integer',
      );
    }
    return this.gitHubAppProviderService.unlinkInstallation(
      userId,
      installationId,
    );
  }

  @Delete('disconnect')
  @ApiBearerAuth()
  @OnlyForAuthorized()
  @ApiOkResponse({ type: UnlinkInstallationResponseDto })
  async disconnectAll(
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<UnlinkInstallationResponseDto> {
    const userId = ctx.checkSub();
    return this.gitHubAppProviderService.disconnectAll(userId);
  }
}
