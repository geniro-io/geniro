import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CtxStorage, OnlyForAuthorized } from '@packages/http-server';

import { AppContextStorage } from '../../../auth/app-context-storage';
import {
  OAuthExchangeRequestDto,
  OAuthExchangeResponseDto,
  OAuthProviderParamDto,
  OAuthStartQueryDto,
  OAuthStartResponseDto,
  OAuthStatusResponseDto,
} from '../dto/oauth-credentials.dto';
import { OAuthCredentialsService } from '../services/oauth-credentials.service';

@ApiTags('oauth')
@Controller('oauth')
@ApiBearerAuth()
@OnlyForAuthorized()
export class OAuthCredentialsController {
  constructor(private readonly service: OAuthCredentialsService) {}

  // Each start() mints a short-lived Redis state entry + a PKCE hash; rate-limit
  // to bound state-flooding. Project ownership of `x-project-id` follows the
  // codebase-wide convention (UUID-validated header, same model as the secrets
  // module) — it is not re-checked here.
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Get(':provider/start')
  @ApiOkResponse({ type: OAuthStartResponseDto })
  async start(
    @Param() params: OAuthProviderParamDto,
    @Query() query: OAuthStartQueryDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<OAuthStartResponseDto> {
    return await this.service.start(ctx, params.provider, query);
  }

  @Get(':provider/status')
  @ApiOkResponse({ type: OAuthStatusResponseDto })
  async status(
    @Param() params: OAuthProviderParamDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<OAuthStatusResponseDto> {
    return await this.service.status(ctx, params.provider);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('credentials/exchange')
  @ApiOkResponse({ type: OAuthExchangeResponseDto })
  async exchange(
    @Body() dto: OAuthExchangeRequestDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<OAuthExchangeResponseDto> {
    const result = await this.service.exchange(ctx, dto);
    return {
      provider: result.provider,
      authenticated: true as const,
      accountLabel: result.accountLabel,
      secretName: result.secretName,
    };
  }
}
