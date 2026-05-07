import { BaseException } from './base.exception';

export class ForbiddenException extends BaseException {
  constructor(errorCode?: string, customData?: Record<string, unknown>);
  constructor(
    errorCode?: string,
    description?: string,
    customData?: Record<string, unknown>,
  );
  constructor(
    errorCode: string = 'FORBIDDEN',
    description?: Record<string, unknown> | string,
    customData?: Record<string, unknown>,
  ) {
    if (typeof description === 'object') {
      customData = description;
      description = undefined;
    }

    super(errorCode, 403, {
      description,
      customData,
    });

    this.name = ForbiddenException.name;
  }
}
