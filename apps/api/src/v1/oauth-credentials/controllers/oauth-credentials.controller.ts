import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
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

  // Static `credentials` segment — no collision with `:provider/start|status`
  // (those are two segments deep; Fastify prioritises the static route anyway).
  @Get('credentials')
  // Unique operationId — the default factory uses only the method name, which
  // collides with litellm's `listCredentials` and breaks `generate:api`.
  @ApiOperation({ operationId: 'listOAuthCredentials' })
  @ApiOkResponse({ type: OAuthStatusResponseDto, isArray: true })
  async listCredentials(
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<OAuthStatusResponseDto[]> {
    return await this.service.listCredentials(ctx);
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

  // Disconnect a provider for the current project: deletes the credential row
  // and its OpenBao token siblings (see service). Project ownership follows the
  // `x-project-id` header convention, same as the rest of the module.
  @Delete(':provider/credentials')
  @ApiOperation({ operationId: 'disconnectOAuthCredential' })
  @HttpCode(204)
  async disconnect(
    @Param() params: OAuthProviderParamDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<void> {
    return await this.service.disconnect(ctx, params.provider);
  }
}
