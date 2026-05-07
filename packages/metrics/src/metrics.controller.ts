import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';

import { MetricsService } from './services/metrics.service.js';

@Controller({
  path: 'metrics',
  version: VERSION_NEUTRAL,
})
@ApiTags('metrics')
@ApiExcludeController()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @ApiOperation({
    description: 'Get prom metric',
  })
  public async getMetrics(): Promise<string> {
    return this.metricsService.getAll();
  }
}
