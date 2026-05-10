import {
  type DynamicModule,
  Global,
  type MiddlewareConsumer,
  Module,
  type OnModuleInit,
} from '@nestjs/common';
import { AppBootstrapperConfigService } from '@packages/common';

import { MetricsController } from './metrics.controller';
import { FastifyMetricsMiddleware } from './metrics.middleware';
import {
  InstanceMetric,
  RequestMetric,
  RequestTimeMetric,
} from './metrics.types';
import { MetricsService } from './services/metrics.service';

@Module({})
@Global()
export class MetricsModule implements OnModuleInit {
  public static init?: (svc: MetricsService) => void;

  static forRoot(init?: (svc: MetricsService) => void): DynamicModule {
    MetricsModule.init = init;

    return {
      module: MetricsModule,
      controllers: [MetricsController],
      providers: [MetricsService],
      exports: [MetricsService],
    };
  }

  constructor(
    private metricsService: MetricsService,
    private appBootstrapperConfigService: AppBootstrapperConfigService,
  ) {}

  onModuleInit() {
    if (MetricsModule.init) {
      MetricsModule.init(this.metricsService);
    }

    this.metricsService.registerGauge(
      RequestMetric,
      'counter for incoming requests',
      ['path', 'method', 'status'],
    );

    this.metricsService.registerHistogram(
      RequestTimeMetric,
      'incoming requests time',
      ['path', 'method'],
      //  [0.1, 0.5, 1, 2, 5, 10, 30],
    );

    this.metricsService.registerGauge(InstanceMetric, 'Application instance', [
      'version',
      'pid',
      'app',
    ]);

    setInterval(() => {
      this.metricsService.incGauge(InstanceMetric, 1, {
        version: this.appBootstrapperConfigService.appVersion,
        pid: String(process.pid),
        app: this.appBootstrapperConfigService.appName,
      });
    }, 60 * 1000);
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(FastifyMetricsMiddleware).forRoutes('*path');
  }
}
