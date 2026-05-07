import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { OnlyForAuthorized } from '@packages/http-server';

import { TemplateDto } from '../dto/templates.dto';
import { TemplatesService } from '../services/templates.service';

@Controller('templates')
@ApiTags('templates')
@ApiBearerAuth()
@OnlyForAuthorized()
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Get()
  @ApiOkResponse({ type: TemplateDto, isArray: true })
  async getAllTemplates(): Promise<TemplateDto[]> {
    return await this.templatesService.getAllTemplates();
  }
}
