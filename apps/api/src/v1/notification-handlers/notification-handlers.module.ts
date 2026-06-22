import { Module, OnModuleInit } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { GraphsModule } from '../graphs/graphs.module';
import { LitellmModule } from '../litellm/litellm.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProjectsModule } from '../projects/projects.module';
import { ThreadsModule } from '../threads/threads.module';
import { SocketGateway } from './gateways/socket.gateway';
import { AgentInvokeNotificationHandler } from './services/event-handlers/agent-invoke-notification-handler';
import { AgentMessageNotificationHandler } from './services/event-handlers/agent-message-notification-handler';
import { AuthRequiredNotificationHandler } from './services/event-handlers/auth-required-notification-handler';
import { CredentialAcquiredNotificationHandler } from './services/event-handlers/credential-acquired-notification-handler';
import { GraphRevisionNotificationHandler } from './services/event-handlers/graph-revision-notification-handler';
import { SimpleEnrichmentHandler } from './services/event-handlers/simple-enrichment-handler';
import { ThreadLifecycleNotificationHandler } from './services/event-handlers/thread-lifecycle-notification-handler';
import { ThreadUpdateNotificationHandler } from './services/event-handlers/thread-update-notification-handler';
import { NotificationHandler } from './services/notification-handler.service';

@Module({
  imports: [
    GraphsModule,
    NotificationsModule,
    ThreadsModule,
    AgentsModule,
    LitellmModule,
    ProjectsModule,
  ],
  providers: [
    SimpleEnrichmentHandler,
    GraphRevisionNotificationHandler,
    AgentMessageNotificationHandler,
    AgentInvokeNotificationHandler,
    ThreadLifecycleNotificationHandler,
    ThreadUpdateNotificationHandler,
    AuthRequiredNotificationHandler,
    CredentialAcquiredNotificationHandler,
    NotificationHandler,
    SocketGateway,
  ],
  exports: [NotificationHandler],
})
export class NotificationHandlersModule implements OnModuleInit {
  constructor(
    private readonly eventsHandlerService: NotificationHandler,
    private readonly simpleEnrichmentHandler: SimpleEnrichmentHandler,
    private readonly graphRevisionHandler: GraphRevisionNotificationHandler,
    private readonly agentMessageHandler: AgentMessageNotificationHandler,
    private readonly agentInvokeHandler: AgentInvokeNotificationHandler,
    private readonly threadLifecycleHandler: ThreadLifecycleNotificationHandler,
    private readonly threadUpdateHandler: ThreadUpdateNotificationHandler,
    private readonly authRequiredHandler: AuthRequiredNotificationHandler,
    private readonly credentialAcquiredHandler: CredentialAcquiredNotificationHandler,
  ) {}

  async onModuleInit() {
    this.eventsHandlerService.registerHandler(this.simpleEnrichmentHandler);
    this.eventsHandlerService.registerHandler(this.graphRevisionHandler);
    this.eventsHandlerService.registerHandler(this.agentMessageHandler);
    this.eventsHandlerService.registerHandler(this.agentInvokeHandler);
    this.eventsHandlerService.registerHandler(this.threadLifecycleHandler);
    this.eventsHandlerService.registerHandler(this.threadUpdateHandler);
    this.eventsHandlerService.registerHandler(this.authRequiredHandler);
    this.eventsHandlerService.registerHandler(this.credentialAcquiredHandler);

    await this.eventsHandlerService.init();
  }
}
