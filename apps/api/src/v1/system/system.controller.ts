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
import { GitPatModeService } from '../git-auth/services/git-pat-mode.service';
import { GitHubAppService } from '../git-auth/services/github-app.service';
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
    private readonly gitPatModeService: GitPatModeService,
  ) {}

  @Get('settings')
  @ApiBearerAuth()
  @OnlyForAuthorized()
  @ApiOkResponse({ type: SystemSettingsResponseDto })
  getSettings(@CtxData() ctx: IContextData): SystemSettingsResponseDto {
    const appConfigured = this.gitHubAppService.isConfigured();
    const patMode = this.gitPatModeService.isPatMode();
    return {
      // Literal App config — independent of the active mode (the App env vars
      // may be set even while GITHUB_AUTH_MODE=pat).
      githubAppEnabled: appConfigured,
      githubAuthMode: this.gitPatModeService.mode(),
      githubAvailable: patMode
        ? this.gitPatModeService.isPatConfigured()
        : appConfigured,
      githubAppInstallable: !patMode && appConfigured,
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
