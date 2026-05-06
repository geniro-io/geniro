import { DefaultLogger } from '@packages/common';

import { NotificationsService } from '../../../../v1/notifications/services/notifications.service';
import { RuntimeInstanceDao } from '../../../../v1/runtime/dao/runtime-instance.dao';
import {
  RuntimeStartingPhase,
  RuntimeType,
} from '../../../../v1/runtime/runtime.types';
import { BaseRuntime } from '../../../../v1/runtime/services/base-runtime';
import { RuntimeProvider } from '../../../../v1/runtime/services/runtime-provider';
import { MockRuntime } from './mock-runtime';
import { MockRuntimeService } from './mock-runtime.service';

/**
 * Drop-in replacement for `RuntimeProvider` in tests. Inherits all the
 * production lifecycle (DAO writes, status transitions, notifications) but
 * swaps the runtime construction to `MockRuntime` for every supported
 * runtime type — so tests requesting a `Docker`, `Daytona`, or `K8s` runtime
 * silently get an in-process mock.
 *
 * Wired in `setup.ts` via NestJS `.overrideProvider(RuntimeProvider).useFactory(...)`.
 */
export class MockRuntimeProvider extends RuntimeProvider {
  constructor(
    runtimeInstanceDao: RuntimeInstanceDao,
    logger: DefaultLogger,
    notificationsService: NotificationsService,
    private readonly mockRuntimeService: MockRuntimeService,
  ) {
    super(runtimeInstanceDao, logger, notificationsService, null);
  }

  protected override resolveRuntimeByType(
    _type: RuntimeType,
  ): BaseRuntime | undefined {
    return new MockRuntime(this.mockRuntimeService);
  }

  protected override resolveRuntimeConfigByType(
    _type: RuntimeType,
  ): Record<string, unknown> | undefined {
    return { mocked: true };
  }

  /** Force the default runtime type to Docker so tests don't need a Daytona stub. */
  public override getDefaultRuntimeType(): RuntimeType {
    return RuntimeType.Docker;
  }
}

/** Re-exported so tests can assert on the phases the mock emits. */
export { RuntimeStartingPhase };
