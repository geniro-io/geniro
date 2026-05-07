import { BaseException } from './base.exception';

export class InternalException extends BaseException {
  constructor(errorCode?: string, customData?: Record<string, unknown>);
  constructor(
    errorCode?: string,
    description?: string,
    customData?: Record<string, unknown>,
  );
  constructor(
    errorCode: string = 'INTERNAL_SERVER_ERROR',
    description?: Record<string, unknown> | string,
    customData?: Record<string, unknown>,
  ) {
    if (typeof description === 'object') {
      customData = description;
      description = undefined;
    }

    super(errorCode, 500, {
      description,
      customData,
    });

    this.name = InternalException.name;
  }
}
