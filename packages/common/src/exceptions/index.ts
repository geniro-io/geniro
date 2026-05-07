import { EXCEPTION_CODES } from './exceptions.codes.js';
import { BadRequestException } from './instances/bad-request.exception.js';
import { BaseException } from './instances/base.exception.js';
import { ConflictException } from './instances/conflict.exception.js';
import { ForbiddenException } from './instances/forbidden.exception.js';
import { InternalException } from './instances/internal.exception.js';
import { NotFoundException } from './instances/not-found.exception.js';
import { UnauthorizedException } from './instances/unauthorized.exception.js';
import { ValidationException } from './instances/validation.exception.js';

export * from './exceptions.codes.js';
export * from './exceptions.types.js';

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
