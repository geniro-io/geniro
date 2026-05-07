import { type IAppBootstrapperExtension } from '@packages/common';

import { MetricsModule } from './metrics.module.js';
import { MetricsService } from './services/metrics.service.js';

export * from './metrics.module.js';
export * from './metrics.types.js';
export * from './services/metrics.service.js';

export const buildMetricExtension = (
  init?: (svc: MetricsService) => void,
): IAppBootstrapperExtension => {
  return {
    modules: [MetricsModule.forRoot(init)],
  };
};
