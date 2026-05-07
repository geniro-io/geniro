import { type IAppBootstrapperExtension } from '@packages/common';

import { MetricsModule } from './metrics.module';
import { MetricsService } from './services/metrics.service';

export * from './metrics.module';
export * from './metrics.types';
export * from './services/metrics.service';

export const buildMetricExtension = (
  init?: (svc: MetricsService) => void,
): IAppBootstrapperExtension => {
  return {
    modules: [MetricsModule.forRoot(init)],
  };
};
