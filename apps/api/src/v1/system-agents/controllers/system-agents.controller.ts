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
import { toSystemAgentResponse } from '../system-agents.utils';

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
    return this.systemAgentsService.getAll().map(toSystemAgentResponse);
  }

  @Get(':id')
  @ApiOperation({ operationId: 'getSystemAgentById' })
  @ApiOkResponse({ type: SystemAgentResponseDto })
  async getById(@Param('id') id: string): Promise<SystemAgentResponseDto> {
    return toSystemAgentResponse(this.systemAgentsService.getById(id));
  }
}
