import { Module } from '@nestjs/common';
import { registerEntities } from '@packages/mikroorm';

import { WebhooksModule } from '../webhooks/webhooks.module';
import { GitHubAuthController } from './controllers/github-auth.controller';
import { GitHubWebhookController } from './controllers/github-webhook.controller';
import { GitProviderConnectionDao } from './dao/git-provider-connection.dao';
import { GitProviderConnectionEntity } from './entity/git-provider-connection.entity';
import { GitPatModeService } from './services/git-pat-mode.service';
import { GitTokenResolverService } from './services/git-token-resolver.service';
import { GitHubAppService } from './services/github-app.service';
import { GitHubAppProviderService } from './services/github-app-provider.service';
import { GitHubWebhookSignatureService } from './services/github-webhook-signature.service';
import { GitHubWebhookSubscriptionService } from './services/webhook-subscription-registry.service';

@Module({
  imports: [registerEntities([GitProviderConnectionEntity]), WebhooksModule],
  controllers: [GitHubAuthController, GitHubWebhookController],
  providers: [
    GitProviderConnectionDao,
    GitHubAppService,
    GitHubAppProviderService,
    GitPatModeService,
    GitTokenResolverService,
    GitHubWebhookSignatureService,
    GitHubWebhookSubscriptionService,
  ],
  exports: [
    GitTokenResolverService,
    GitHubAppService,
    GitHubAppProviderService,
    GitPatModeService,
    // GitProviderConnectionDao is exported for integration tests that need direct DB seeding/cleanup
    GitProviderConnectionDao,
    GitHubWebhookSubscriptionService,
  ],
})
export class GitAuthModule {}
