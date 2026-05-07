import { BaseException } from './base.exception';

export class NotFoundException extends BaseException {
  constructor(errorCode?: string, customData?: Record<string, unknown>);
  constructor(
    errorCode?: string,
    description?: string,
    customData?: Record<string, unknown>,
  );
  constructor(
    errorCode: string = 'NOT_FOUND',
    description?: Record<string, unknown> | string,
    customData?: Record<string, unknown>,
  ) {
    if (typeof description === 'object') {
      customData = description;
      description = undefined;
    }

    super(errorCode, 404, {
      description,
      customData,
    });

    this.name = NotFoundException.name;
  }
}
