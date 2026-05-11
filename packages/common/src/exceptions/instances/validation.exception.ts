import { type IExceptionFieldError } from '../exceptions.types';
import { BaseException } from './base.exception';

export class ValidationException extends BaseException {
  constructor(
    errorCode: string = 'VALIDATION_ERROR',
    description?: string,
    public fields?: IExceptionFieldError[],
    customData?: Record<string, unknown>,
  ) {
    super(errorCode, 403, {
      description,
      customData,
      fields,
    });

    this.name = ValidationException.name;
  }
}
