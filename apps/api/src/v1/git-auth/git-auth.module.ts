import { Module } from '@nestjs/common';
import { registerEntities } from '@packages/mikroorm';

import { SecretsStoreModule } from '../secrets-store/secrets-store.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { GitUserPatController } from './controllers/git-user-pat.controller';
import { GitHubAuthController } from './controllers/github-auth.controller';
import { GitHubWebhookController } from './controllers/github-webhook.controller';
import { GitProviderConnectionDao } from './dao/git-provider-connection.dao';
import { GitUserPatDao } from './dao/git-user-pat.dao';
import { GitProviderConnectionEntity } from './entity/git-provider-connection.entity';
import { GitUserPatEntity } from './entity/git-user-pat.entity';
import { GitPatValidatorService } from './services/git-pat-validator.service';
import { GitTokenResolverService } from './services/git-token-resolver.service';
import { GitUserPatService } from './services/git-user-pat.service';
import { GitHubAppService } from './services/github-app.service';
import { GitHubAppProviderService } from './services/github-app-provider.service';
import { GitHubWebhookSignatureService } from './services/github-webhook-signature.service';
import { GitHubWebhookSubscriptionService } from './services/webhook-subscription-registry.service';

@Module({
  imports: [
    registerEntities([GitProviderConnectionEntity, GitUserPatEntity]),
    WebhooksModule,
    SecretsStoreModule,
  ],
  controllers: [
    GitHubAuthController,
    GitHubWebhookController,
    GitUserPatController,
  ],
  providers: [
    GitProviderConnectionDao,
    GitUserPatDao,
    GitHubAppService,
    GitHubAppProviderService,
    GitPatValidatorService,
    GitUserPatService,
    GitTokenResolverService,
    GitHubWebhookSignatureService,
    GitHubWebhookSubscriptionService,
  ],
  exports: [
    GitTokenResolverService,
    GitHubAppService,
    GitHubAppProviderService,
    GitUserPatService,
    // GitProviderConnectionDao is exported for integration tests that need direct DB seeding/cleanup
    GitProviderConnectionDao,
    GitUserPatDao,
    GitHubWebhookSubscriptionService,
  ],
})
export class GitAuthModule {}
