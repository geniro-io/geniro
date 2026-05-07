import { BaseException } from './base.exception';

export class ConflictException extends BaseException {
  constructor(errorCode?: string, customData?: Record<string, unknown>);
  constructor(
    errorCode?: string,
    description?: string,
    customData?: Record<string, unknown>,
  );
  constructor(
    errorCode: string = 'CONFLICT',
    description?: Record<string, unknown> | string,
    customData?: Record<string, unknown>,
  ) {
    if (typeof description === 'object') {
      customData = description;
      description = undefined;
    }

    super(errorCode, 409, {
      description,
      customData,
    });

    this.name = ConflictException.name;
  }
}
