import { Module } from '@nestjs/common';
import { registerEntities } from '@packages/mikroorm';

import { NotificationsModule } from '../notifications/notifications.module';
import { SecretsStoreModule } from '../secrets-store/secrets-store.module';
import { OAuthCredentialsController } from './controllers/oauth-credentials.controller';
import { OAuthCredentialsDao } from './dao/oauth-credentials.dao';
import { OAuthCredentialEntity } from './entity/oauth-credential.entity';
import { LinearOAuthProvider } from './providers/linear-oauth-provider';
import { OAuthCredentialsService } from './services/oauth-credentials.service';
import { OAuthExchangeService } from './services/oauth-exchange.service';

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
    // Per-provider OAuth strategies — a new provider is one class + one line
    // here (mirrors agent-mcp.module.ts), zero edits to the exchange service.
    LinearOAuthProvider,
  ],
  exports: [OAuthCredentialsService],
})
export class OAuthCredentialsModule {}
