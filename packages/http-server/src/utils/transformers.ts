import { Transform, type TransformFnParams } from 'class-transformer';
import { isNumberString } from 'class-validator';
import { isArray, isNumber, isString } from 'lodash';

export const TransformQueryArray = (type?: (...args: unknown[]) => unknown) => {
  return function (target: object, propertyKey: string | symbol) {
    Transform(({ value }: TransformFnParams) => {
      let val = value as unknown;

      if (isString(val)) {
        val = val.split(',');
      }

      return (val as unknown[])?.map((v: unknown) => (type ? type(v) : v));
    })(target, propertyKey);
  };
};

export type TransformEnumOptions<T extends { [key: string]: unknown }> = {
  /**
   * Indicates if multiple enum values can be used as the same time (thus being an array).
   * Defaults to `false`.
   */
  isArray?: boolean;

  /**
   * The enum that should be represented.
   */
  enum: T;

  /**
   * The type of the enum values. Defaults to `'number'`.
   */
  type?: 'string' | 'number';
};

export const TransformEnum = <T extends { [key: string]: unknown }>(
  options: TransformEnumOptions<T>,
) => {
  return function (target: object, propertyKey: string | symbol) {
    Transform(({ value }: TransformFnParams) => {
      let val = value as unknown;

      if (!isArray(val)) {
        val = [val];
      }

      const valArray = val as unknown[];
      for (const i in valArray) {
        if (options.type === 'number' && !isNumber(valArray[i])) {
          if (isNumberString(valArray[i])) {
            valArray[i] = Number(valArray[i]);
          } else {
            const key = String(valArray[i]);
            valArray[i] = options.enum[key];
          }
        }

        if (options.type === 'string' && !isString(valArray[i])) {
          const key = String(valArray[i]);
          valArray[i] = options.enum[key];
        }
      }

      return options.isArray ? valArray : valArray[0];
    })(target, propertyKey);
  };
};
