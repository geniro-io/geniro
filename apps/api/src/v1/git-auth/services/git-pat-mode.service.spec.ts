import { InternalException } from '@packages/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GitHubAuthMethod } from '../../graph-resources/graph-resources.types';
import { GitPatModeService } from './git-pat-mode.service';

const mockEnvironment: Record<string, unknown> = {
  githubAuthMode: 'app',
  githubPat: '',
};

vi.mock('../../../environments', () => ({
  get environment() {
    return mockEnvironment;
  },
}));

describe('GitPatModeService', () => {
  let service: GitPatModeService;

  beforeEach(() => {
    service = new GitPatModeService();
    mockEnvironment.githubAuthMode = 'app';
    mockEnvironment.githubPat = '';
  });

  describe('mode / isPatMode', () => {
    it('defaults to GithubApp (app) mode', () => {
      expect(service.mode()).toBe(GitHubAuthMethod.GithubApp);
      expect(service.isPatMode()).toBe(false);
    });

    it('resolves Pat when GITHUB_AUTH_MODE is "pat"', () => {
      mockEnvironment.githubAuthMode = 'pat';
      expect(service.mode()).toBe(GitHubAuthMethod.Pat);
      expect(service.isPatMode()).toBe(true);
    });

    it('treats an unknown/typo mode value as app (fail-safe default)', () => {
      mockEnvironment.githubAuthMode = 'patt';
      expect(service.mode()).toBe(GitHubAuthMethod.GithubApp);
      expect(service.isPatMode()).toBe(false);
    });
  });

  describe('isPatConfigured', () => {
    it('is false in app mode even when a PAT is present', () => {
      mockEnvironment.githubPat = 'ghp_present';
      expect(service.isPatConfigured()).toBe(false);
    });

    it('is false in pat mode with an empty PAT', () => {
      mockEnvironment.githubAuthMode = 'pat';
      expect(service.isPatConfigured()).toBe(false);
    });

    it('is true in pat mode with a non-empty PAT', () => {
      mockEnvironment.githubAuthMode = 'pat';
      mockEnvironment.githubPat = 'ghp_abc';
      expect(service.isPatConfigured()).toBe(true);
    });
  });

  describe('getValidatedPat (fail-closed)', () => {
    it('throws the not-active branch when not in pat mode', () => {
      mockEnvironment.githubPat = 'ghp_abc';
      expect(() => service.getValidatedPat()).toThrow(InternalException);
      expect(() => service.getValidatedPat()).toThrow('was called while');
    });

    it('throws the MISSING branch when pat mode but the PAT is unset/empty', () => {
      mockEnvironment.githubAuthMode = 'pat';
      mockEnvironment.githubPat = '';
      expect(() => service.getValidatedPat()).toThrow('empty or unset');
    });

    it('throws the MISSING branch when the PAT is whitespace-only (trims to empty)', () => {
      mockEnvironment.githubAuthMode = 'pat';
      mockEnvironment.githubPat = '   \n';
      expect(() => service.getValidatedPat()).toThrow('empty or unset');
    });

    it('throws the INVALID branch (not MISSING) on embedded whitespace', () => {
      mockEnvironment.githubAuthMode = 'pat';
      mockEnvironment.githubPat = 'ghp_ab cd';
      expect(() => service.getValidatedPat()).toThrow('embedded whitespace');
    });

    it('throws the INVALID branch on an embedded newline too', () => {
      mockEnvironment.githubAuthMode = 'pat';
      mockEnvironment.githubPat = 'ghp_ab\ncd';
      expect(() => service.getValidatedPat()).toThrow('embedded whitespace');
    });

    it('returns the trimmed PAT when valid (strips surrounding whitespace/newline)', () => {
      mockEnvironment.githubAuthMode = 'pat';
      mockEnvironment.githubPat = '  ghp_validtoken123\n';
      expect(service.getValidatedPat()).toBe('ghp_validtoken123');
    });

    it('accepts a github_pat_ fine-grained token', () => {
      mockEnvironment.githubAuthMode = 'pat';
      mockEnvironment.githubPat = 'github_pat_abc123';
      expect(service.getValidatedPat()).toBe('github_pat_abc123');
    });
  });
});
