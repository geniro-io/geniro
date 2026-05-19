import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { environment } from './environments';
import { AgentsModule } from './v1/agents/agents.module';
import { AiSuggestionsModule } from './v1/ai-suggestions/ai-suggestions.module';
import { AnalyticsModule } from './v1/analytics/analytics.module';
import { CacheModule } from './v1/cache/cache.module';
import { GitAuthModule } from './v1/git-auth/git-auth.module';
import { GitRepositoriesModule } from './v1/git-repositories/git-repositories.module';
import { GraphTemplatesModule } from './v1/graph-templates/graph-templates.module';
import { GraphsModule } from './v1/graphs/graphs.module';
import { InstructionBlocksModule } from './v1/instruction-blocks/instruction-blocks.module';
import { KnowledgeModule } from './v1/knowledge/knowledge.module';
import { LitellmModule } from './v1/litellm/litellm.module';
import { NotificationHandlersModule } from './v1/notification-handlers/notification-handlers.module';
import { ProjectsModule } from './v1/projects/projects.module';
import { RuntimeModule } from './v1/runtime/runtime.module';
import { SystemModule } from './v1/system/system.module';
import { SystemAgentsModule } from './v1/system-agents/system-agents.module';
import { ThreadStoreModule } from './v1/thread-store/thread-store.module';
import { ThreadsModule } from './v1/threads/threads.module';
import { UserPreferencesModule } from './v1/user-preferences/user-preferences.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: environment.env === 'development' ? 1000 : 100,
      },
    ]),
    CacheModule,
    RuntimeModule,
    AgentsModule,
    AiSuggestionsModule,
    AnalyticsModule,
    GraphsModule,
    LitellmModule,
    KnowledgeModule,
    GraphTemplatesModule,
    SystemAgentsModule,
    InstructionBlocksModule,
    GitAuthModule,
    GitRepositoriesModule,
    NotificationHandlersModule,
    ProjectsModule,
    SystemModule,
    ThreadsModule,
    ThreadStoreModule,
    UserPreferencesModule,
  ],
  controllers: [],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
