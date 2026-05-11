import { forwardRef, Module } from '@nestjs/common';
import { registerEntities } from '@packages/mikroorm';

import { AgentsModule } from '../agents/agents.module';
import { GraphsModule } from '../graphs/graphs.module';
import { LitellmModule } from '../litellm/litellm.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OpenaiModule } from '../openai/openai.module';
import { ThreadsController } from './controllers/threads.controller';
import { MessagesDao } from './dao/messages.dao';
import { MessageEntity } from './entity/message.entity';
import { ThreadNameGeneratorService } from './services/thread-name-generator.service';
import { ThreadResumeService } from './services/thread-resume.service';
import { ThreadResumeQueueService } from './services/thread-resume-queue.service';
import { ThreadStatusTransitionService } from './services/thread-status-transition.service';
import { ThreadsService } from './services/threads.service';
import { THREADS_SERVICE_TOKEN } from './services/threads.tokens';
import { ThreadsListener } from './threads.listener';
import { ThreadsDaoModule } from './threads-dao.module';

@Module({
  imports: [
    registerEntities([MessageEntity]),
    ThreadsDaoModule,
    forwardRef(() => AgentsModule),
    forwardRef(() => GraphsModule),
    NotificationsModule,
    LitellmModule,
    OpenaiModule,
  ],
  controllers: [ThreadsController],
  providers: [
    ThreadsService,
    { provide: THREADS_SERVICE_TOKEN, useExisting: ThreadsService },
    MessagesDao,
    ThreadNameGeneratorService,
    ThreadsListener,
    ThreadResumeQueueService,
    ThreadResumeService,
    ThreadStatusTransitionService,
  ],
  exports: [
    ThreadsDaoModule,
    MessagesDao,
    ThreadsService,
    THREADS_SERVICE_TOKEN,
    ThreadNameGeneratorService,
    ThreadResumeQueueService,
    ThreadResumeService,
    ThreadStatusTransitionService,
  ],
})
export class ThreadsModule {}
