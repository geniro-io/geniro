import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { isUndefined } from 'lodash';

export function IsRequiredIf(
  cb: (object: unknown) => boolean,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isRequiredIf',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [cb],
      options: {
        message: (args: ValidationArguments) =>
          `${args.property} must be provided`,
        ...(validationOptions || {}),
      },
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const [callback] = args.constraints as [(object: unknown) => boolean];

          if (callback(args.object) && isUndefined(value)) {
            return false;
          }

          return true;
        },
      },
    });
  };
}
