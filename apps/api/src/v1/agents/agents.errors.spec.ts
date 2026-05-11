import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { CostLimitExceededError } from './agents.errors';

describe('agents.errors', () => {
  describe('CostLimitExceededError', () => {
    it('should be an instance of Error', () => {
      const error = new CostLimitExceededError(1.5, 2.0);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(CostLimitExceededError);
    });

    it('should set name to "CostLimitExceededError"', () => {
      const error = new CostLimitExceededError(1.5, 2.0);

      expect(error.name).toBe('CostLimitExceededError');
    });

    it('should set message to "COST_LIMIT_EXCEEDED"', () => {
      const error = new CostLimitExceededError(1.5, 2.0);

      expect(error.message).toBe('COST_LIMIT_EXCEEDED');
    });

    it('should preserve effectiveLimitUsd and totalPriceUsd fields from constructor', () => {
      const error = new CostLimitExceededError(0.25, 0.37);

      expect(error.effectiveLimitUsd).toBe(0.25);
      expect(error.totalPriceUsd).toBe(0.37);
    });

    it('should preserve zero values for effectiveLimitUsd and totalPriceUsd', () => {
      const error = new CostLimitExceededError(0, 0);

      expect(error.effectiveLimitUsd).toBe(0);
      expect(error.totalPriceUsd).toBe(0);
    });

    it('should distinguish CostLimitExceededError from other Error subclasses via instanceof', () => {
      const costError = new CostLimitExceededError(1, 2);
      const otherError = new TypeError('some type error');
      const plainError = new Error('plain error');

      expect(costError instanceof CostLimitExceededError).toBe(true);
      expect(otherError instanceof CostLimitExceededError).toBe(false);
      expect(plainError instanceof CostLimitExceededError).toBe(false);
    });
  });

  describe('CostLimitExceededError — Pino-leak hardening', () => {
    it('toJSON excludes inFlightMessages body', () => {
      const err = new CostLimitExceededError(0.5, 0.576, [
        new AIMessage('secret content'),
      ]);

      const serialized = JSON.stringify(err);

      expect(serialized).not.toContain('secret content');
    });

    it('toJSON includes envelope fields and inFlightMessageCount', () => {
      const err = new CostLimitExceededError(0.5, 0.576, [
        new AIMessage('some message'),
      ]);

      const parsed = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;

      expect(parsed).toHaveProperty('name', 'CostLimitExceededError');
      expect(parsed).toHaveProperty('message', 'COST_LIMIT_EXCEEDED');
      expect(parsed).toHaveProperty('effectiveLimitUsd', 0.5);
      expect(parsed).toHaveProperty('totalPriceUsd', 0.576);
      expect(parsed).toHaveProperty('inFlightMessageCount', 1);
    });

    it('inFlightMessages is non-enumerable (Pino-spread safe)', () => {
      const err = new CostLimitExceededError(0.5, 0.576, [
        new AIMessage('sensitive body'),
      ]);

      expect(Object.keys(err)).not.toContain('inFlightMessages');
      expect(JSON.stringify({ ...err })).not.toContain('sensitive body');
    });

    it('inFlightMessages remains accessible via direct property read', () => {
      const messages = [new AIMessage('direct read content')];
      const err = new CostLimitExceededError(0.5, 0.576, messages);

      expect(err.inFlightMessages).toBe(messages);
      expect(err.inFlightMessages).toHaveLength(1);
    });
  });
});
