import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

export function IsEqual(value: unknown, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isEqual',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [value],
      options: {
        message: () => `${propertyName} must be equal to ${value}`,
        ...(validationOptions || {}),
      },
      validator: {
        validate(propertyValue: unknown, args: ValidationArguments) {
          return propertyValue === args.constraints[0];
        },
      },
    });
  };
}
