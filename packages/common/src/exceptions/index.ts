import { EXCEPTION_CODES } from './exceptions.codes';
import { BadRequestException } from './instances/bad-request.exception';
import { BaseException } from './instances/base.exception';
import { ConflictException } from './instances/conflict.exception';
import { ForbiddenException } from './instances/forbidden.exception';
import { InternalException } from './instances/internal.exception';
import { NotFoundException } from './instances/not-found.exception';
import { UnauthorizedException } from './instances/unauthorized.exception';
import { ValidationException } from './instances/validation.exception';

export * from './exceptions.codes';
export * from './exceptions.types';

export {
  BadRequestException,
  BaseException,
  ConflictException,
  ForbiddenException,
  InternalException,
  NotFoundException,
  UnauthorizedException,
  ValidationException,
};

/**
 * Add new exception codes
 * @param data
 */
export const addExceptionCode = (data: { [key: string]: string }) => {
  for (const i in data) {
    EXCEPTION_CODES[i] = data[i]!;
  }
};
