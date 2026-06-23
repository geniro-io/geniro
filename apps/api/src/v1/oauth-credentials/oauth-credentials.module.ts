import { Module } from '@nestjs/common';
import { registerEntities } from '@packages/mikroorm';

import { NotificationsModule } from '../notifications/notifications.module';
import { SecretsStoreModule } from '../secrets-store/secrets-store.module';
import { OAuthCredentialsController } from './controllers/oauth-credentials.controller';
import { OAuthCredentialsDao } from './dao/oauth-credentials.dao';
import { OAuthCredentialEntity } from './entity/oauth-credential.entity';
import { LinearOAuthProvider } from './providers/linear-oauth-provider';
import { OAuthCapabilityLinkService } from './services/oauth-capability-link.service';
import { OAuthCredentialsService } from './services/oauth-credentials.service';
import { OAuthExchangeService } from './services/oauth-exchange.service';
import { OAuthTokenRefreshService } from './services/oauth-token-refresh.service';

@Module({
  imports: [
    registerEntities([OAuthCredentialEntity]),
    SecretsStoreModule,
    NotificationsModule,
  ],
  controllers: [OAuthCredentialsController],
  providers: [
    OAuthCredentialsDao,
    OAuthCredentialsService,
    OAuthExchangeService,
    OAuthCapabilityLinkService,
    // Background watchdog: proactively refreshes near-expiry OAuth tokens so a
    // short-lived token never goes stale between runs (BullMQ repeatable tick).
    OAuthTokenRefreshService,
    // Per-provider OAuth strategies — a new provider is one class + one line
    // here (mirrors agent-mcp.module.ts) plus one registry line in
    // OAuthExchangeService's constructor.
    LinearOAuthProvider,
  ],
  exports: [OAuthCredentialsService, OAuthCapabilityLinkService],
})
export class OAuthCredentialsModule {}
