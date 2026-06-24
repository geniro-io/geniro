import { BadRequestException } from '@packages/common';
import { beforeEach, describe, expect, it } from 'vitest';

import { GitPatValidatorService } from './git-pat-validator.service';

describe('GitPatValidatorService', () => {
  let service: GitPatValidatorService;

  beforeEach(() => {
    service = new GitPatValidatorService();
  });

  describe('validate', () => {
    it('accepts a classic ghp_ token and trims surrounding whitespace', () => {
      expect(service.validate('  ghp_abc123  ')).toBe('ghp_abc123');
    });

    it('accepts a fine-grained github_pat_ token', () => {
      expect(service.validate('github_pat_abc123')).toBe('github_pat_abc123');
    });

    it('rejects an empty / whitespace-only value', () => {
      expect(() => service.validate('')).toThrow(BadRequestException);
      expect(() => service.validate('   ')).toThrow(BadRequestException);
    });

    it('rejects a token with embedded whitespace (space or newline)', () => {
      expect(() => service.validate('ghp_abc 123')).toThrow(
        BadRequestException,
      );
      expect(() => service.validate('ghp_abc\n123')).toThrow(
        BadRequestException,
      );
    });

    it('rejects an OAuth user token (gho_)', () => {
      expect(() => service.validate('gho_abc123')).toThrow(BadRequestException);
    });

    it('rejects an installation/server token (ghs_)', () => {
      expect(() => service.validate('ghs_abc123')).toThrow(BadRequestException);
    });

    it('rejects a user-to-server (ghu_) and refresh (ghr_) token', () => {
      expect(() => service.validate('ghu_abc123')).toThrow(BadRequestException);
      expect(() => service.validate('ghr_abc123')).toThrow(BadRequestException);
    });

    it('rejects the sibling token classes case-insensitively', () => {
      expect(() => service.validate('GHO_abc123')).toThrow(BadRequestException);
      expect(() => service.validate('GHS_abc123')).toThrow(BadRequestException);
    });

    it('rejects an unrecognized prefix', () => {
      expect(() => service.validate('xyz_abc123')).toThrow(BadRequestException);
    });
  });

  describe('tokenType', () => {
    it('classifies github_pat_ as fine-grained', () => {
      expect(service.tokenType('github_pat_abc')).toBe('fine-grained');
    });

    it('classifies ghp_ as classic', () => {
      expect(service.tokenType('ghp_abc')).toBe('classic');
    });
  });
});
