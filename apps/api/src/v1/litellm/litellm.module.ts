import { Module } from '@nestjs/common';

import { UserPreferencesModule } from '../user-preferences/user-preferences.module';
import { LiteLlmAdminController } from './controllers/litellm-admin.controller';
import { ModelsController } from './controllers/models.controller';
import { LiteLlmClient } from './services/litellm.client';
import { LitellmService } from './services/litellm.service';
import { LiteLlmAdminService } from './services/litellm-admin.service';
import { LitellmVirtualKeyService } from './services/litellm-virtual-key.service';
import { LlmModelsService } from './services/llm-models.service';

@Module({
  imports: [UserPreferencesModule],
  controllers: [ModelsController, LiteLlmAdminController],
  providers: [
    LiteLlmClient,
    LiteLlmAdminService,
    LitellmService,
    LitellmVirtualKeyService,
    LlmModelsService,
  ],
  exports: [
    LitellmService,
    LitellmVirtualKeyService,
    LlmModelsService,
    LiteLlmClient,
  ],
})
export class LitellmModule {}
