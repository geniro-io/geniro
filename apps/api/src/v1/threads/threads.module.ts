import { forwardRef, Module } from '@nestjs/common';
import { registerEntities } from '@packages/mikroorm';

import { AgentsModule } from '../agents/agents.module';
import { GraphsModule } from '../graphs/graphs.module';
import { LitellmModule } from '../litellm/litellm.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OpenaiModule } from '../openai/openai.module';
import { ThreadsController } from './controllers/threads.controller';
import { MessagesDao } from './dao/messages.dao';
import { ThreadsDao } from './dao/threads.dao';
import { MessageEntity } from './entity/message.entity';
import { ThreadEntity } from './entity/thread.entity';
import { ThreadNameGeneratorService } from './services/thread-name-generator.service';
import { ThreadResumeService } from './services/thread-resume.service';
import { ThreadResumeQueueService } from './services/thread-resume-queue.service';
import { ThreadsService } from './services/threads.service';
import { ThreadsListener } from './threads.listener';

@Module({
  imports: [
    registerEntities([ThreadEntity, MessageEntity]),
    forwardRef(() => AgentsModule),
    forwardRef(() => GraphsModule),
    NotificationsModule,
    LitellmModule,
    OpenaiModule,
  ],
  controllers: [ThreadsController],
  providers: [
    ThreadsService,
    ThreadsDao,
    MessagesDao,
    ThreadNameGeneratorService,
    ThreadsListener,
    ThreadResumeQueueService,
    ThreadResumeService,
  ],
  exports: [
    ThreadsDao,
    MessagesDao,
    ThreadsService,
    ThreadNameGeneratorService,
    ThreadResumeQueueService,
    ThreadResumeService,
  ],
})
export class ThreadsModule {}
