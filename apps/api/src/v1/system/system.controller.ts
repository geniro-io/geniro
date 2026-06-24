import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { IContextData } from '@packages/http-server';
import { CtxData, OnlyForAuthorized } from '@packages/http-server';

import { environment } from '../../environments';
import { GitHubAppService } from '../git-auth/services/github-app.service';
import { SecretsStoreService } from '../secrets-store/services/secrets-store.service';
import {
  AuthConfigResponseDto,
  AuthProviderType,
  SystemSettingsResponseDto,
} from './dto/system.dto';

@ApiTags('system')
@Controller('system')
export class SystemController {
  constructor(
    private readonly gitHubAppService: GitHubAppService,
    private readonly secretsStore: SecretsStoreService,
  ) {}

  @Get('settings')
  @ApiBearerAuth()
  @OnlyForAuthorized()
  @ApiOkResponse({ type: SystemSettingsResponseDto })
  getSettings(@CtxData() ctx: IContextData): SystemSettingsResponseDto {
    return {
      githubAppEnabled: this.gitHubAppService.isConfigured(),
      // Per-user PATs require the secrets store (OpenBao); the settings UI gates
      // the PAT card on this flag.
      githubUserPatEnabled: this.secretsStore.isAvailable(),
      litellmManagementEnabled: environment.litellmManagementEnabled === true,
      isAdmin:
        Array.isArray(ctx.roles) && ctx.roles.includes(environment.adminRole),
      githubWebhookEnabled: Boolean(environment.githubWebhookSecret),
      apiVersion: environment.apiVersion,
      webVersion: environment.webVersion,
    };
  }

  /**
   * Public endpoint (no @OnlyForAuthorized) — intentionally unauthenticated.
   * Returns OIDC provider config needed by the frontend before login.
   * Only expose non-sensitive values here (provider type, issuer URL, client ID).
   */
  @Get('config')
  @ApiOperation({
    summary:
      'Public endpoint (no @OnlyForAuthorized) — intentionally unauthenticated. Returns OIDC provider config needed by the frontend before login. Only expose non-sensitive values here (provider type, issuer URL, client ID).',
  })
  @ApiOkResponse({ type: AuthConfigResponseDto })
  getAuthConfig(): AuthConfigResponseDto {
    const isZitadel = environment.authProvider === 'zitadel';
    return {
      provider: isZitadel
        ? AuthProviderType.Zitadel
        : AuthProviderType.Keycloak,
      issuer: isZitadel
        ? environment.zitadelIssuer
        : `${environment.keycloakUrl}/realms/${environment.keycloakRealm}`,
      clientId: isZitadel
        ? environment.zitadelClientId
        : environment.keycloakClientId,
    };
  }
}
