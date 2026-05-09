import { EXCEPTION_CODES } from '../exceptions.codes';
import {
  type IExceptionData,
  type IExceptionFieldError,
} from '../exceptions.types';

interface BaseExceptionData {
  description?: string;
  fields?: IExceptionFieldError[];
  customData?: Record<string, unknown>;
}

export class BaseException extends Error {
  public readonly errorCode: string;
  public readonly statusCode: number;
  public readonly data: BaseExceptionData;

  constructor(
    errorCode: string,
    statusCode: number,
    data: BaseExceptionData = {},
  ) {
    const description =
      data.description ||
      EXCEPTION_CODES[errorCode] ||
      `[${errorCode}] An exception has occurred`;
    super(description);

    this.errorCode = errorCode;
    this.statusCode = statusCode;
    this.data = data;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BaseException);
    }
    this.name = this.constructor.name;
  }

  get code(): string {
    return this.errorCode;
  }

  public getMessage(): string {
    return (
      this.data.description ||
      EXCEPTION_CODES[this.code] ||
      `An exception has occurred`
    );
  }

  public getFullMessage(): string {
    let msg = this.getMessage();

    if (this.data.fields && this.data.fields.length > 0) {
      const fieldsMsg = this.data.fields
        .map((f) => `${f.name} - ${f.message}`)
        .join(', ');
      msg = `${msg}: ${fieldsMsg}`;
    }

    return `[${this.code}] ${msg}`;
  }

  public static getExceptionData(
    exception: (BaseException | Error) & Partial<{ status: number }>,
  ): IExceptionData {
    const ex = exception as Partial<BaseException>;
    const statusCode = ex.statusCode ?? exception.status ?? 500;
    let code = 'INTERNAL_SERVER_ERROR';
    if (statusCode === 404) {
      code = 'NOT_FOUND';
    } else if (statusCode === 400) {
      code = 'BAD_REQUEST';
    } else if (statusCode === 401) {
      code = 'UNAUTHORIZED';
    } else if (statusCode === 403) {
      code = 'FORBIDDEN';
    } else if (statusCode === 422) {
      code = 'VALIDATION_ERROR';
    }

    return {
      name: exception.name,
      statusCode,
      code: 'code' in ex && ex.code ? ex.code : code,
      message:
        typeof (ex as unknown as { getMessage?: () => string }).getMessage ===
        'function'
          ? (ex as unknown as { getMessage: () => string }).getMessage()
          : exception.message,
      fullMessage:
        typeof (ex as unknown as { getFullMessage?: () => string })
          .getFullMessage === 'function'
          ? (ex as unknown as { getFullMessage: () => string }).getFullMessage()
          : exception.message,
      fields: ex.data?.fields ?? [],
      customData: ex.data?.customData,
    };
  }
}
