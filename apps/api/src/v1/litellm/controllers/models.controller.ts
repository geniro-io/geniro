import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { OnlyForAuthorized } from '@packages/http-server';

import { LiteLlmModelDto, ModelDefaultsDto } from '../dto/models.dto';
import { LitellmService } from '../services/litellm.service';
import { LlmModelsService } from '../services/llm-models.service';

@Controller('litellm')
@ApiTags('litellm')
@ApiBearerAuth()
@OnlyForAuthorized()
export class ModelsController {
  constructor(
    private readonly modelsService: LitellmService,
    private readonly llmModelsService: LlmModelsService,
  ) {}

  @Get('/models')
  @ApiOkResponse({ type: LiteLlmModelDto, isArray: true })
  async listModels(): Promise<LiteLlmModelDto[]> {
    return this.modelsService.listModels();
  }

  @Get('/model-defaults')
  @ApiOkResponse({ type: ModelDefaultsDto })
  getModelDefaults(): ModelDefaultsDto {
    return this.llmModelsService.getModelDefaults();
  }
}
