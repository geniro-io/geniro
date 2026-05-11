import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { OnlyForAuthorized } from '@packages/http-server';

import { SystemAgentResponseDto } from '../dto/system-agents.dto';
import { SystemAgentsService } from '../services/system-agents.service';

@Controller('system-agents')
@ApiTags('system-agents')
@ApiBearerAuth()
@OnlyForAuthorized()
export class SystemAgentsController {
  constructor(private readonly systemAgentsService: SystemAgentsService) {}

  @Get()
  @ApiOperation({ operationId: 'listSystemAgents' })
  @ApiOkResponse({ type: SystemAgentResponseDto, isArray: true })
  async getAll(): Promise<SystemAgentResponseDto[]> {
    return await this.systemAgentsService.getAll();
  }

  @Get(':id')
  @ApiOperation({ operationId: 'getSystemAgentById' })
  @ApiOkResponse({ type: SystemAgentResponseDto })
  async getById(@Param('id') id: string): Promise<SystemAgentResponseDto> {
    return await this.systemAgentsService.getById(id);
  }
}
