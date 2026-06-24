import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import { GitPatType } from '../git-auth.types';

/**
 * Validates the FORMAT of a user-supplied GitHub personal access token (PAT)
 * before it is stored. Stateless and scoped to a single token string — it reads
 * no environment and holds no deployment "mode" (the prior deployment-wide
 * `GITHUB_AUTH_MODE` concept was removed in favour of per-user PATs).
 *
 * Accepts only the two personal-access-token classes — classic (`ghp_`) and
 * fine-grained (`github_pat_`) — and rejects the sibling GitHub token classes
 * (OAuth `gho_`, installation/server `ghs_`, user-to-server `ghu_`, refresh
 * `ghr_`) with a clear message: they are credentials but not PATs and would
 * fail GitHub auth in confusing ways.
 *
 * The token is a secret: only the rejection reason — never the value — appears
 * in the thrown error (sandbox-boundary Logging rule).
 */
@Injectable()
export class GitPatValidatorService {
  /**
   * Returns the trimmed token when it is a well-formed PAT, otherwise throws a
   * `BadRequestException` (this is user-input validation on the save path; the
   * resolve-time present-but-unreadable case is a separate fail-closed
   * `InternalException` in the token resolver).
   */
  validate(rawToken: string): string {
    // Trim first: a copy-pasted/echo-piped value commonly carries a trailing
    // newline, which corrupts both the Authorization header and the clone-URL
    // userinfo segment the PAT is injected into.
    const token = (rawToken || '').trim();
    if (!token) {
      throw new BadRequestException(
        'GITHUB_PAT_MISSING',
        'A GitHub personal access token is required.',
      );
    }
    // Reject embedded whitespace: a real PAT has none, and an internal
    // space/newline is header/URL-unsafe (.trim() above only strips the ends).
    if (/\s/.test(token)) {
      throw new BadRequestException(
        'GITHUB_PAT_INVALID',
        'The token contains whitespace, which is not valid for a personal access token.',
      );
    }
    // A shared "gh" stem is not a discriminator: reject the non-PAT sibling
    // classes explicitly (case-insensitively) so a pasted OAuth/installation
    // token gets a clear message rather than a confusing downstream auth error.
    if (/^gh[osur]_/i.test(token)) {
      throw new BadRequestException(
        'GITHUB_PAT_WRONG_TYPE',
        'That looks like an OAuth, installation, or refresh token, not a personal access token. Use a classic (ghp_) or fine-grained (github_pat_) token.',
      );
    }
    // Accept only the two personal-access-token classes.
    if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
      throw new BadRequestException(
        'GITHUB_PAT_INVALID',
        'Unrecognized token format. Provide a classic (ghp_) or fine-grained (github_pat_) personal access token.',
      );
    }
    return token;
  }

  /**
   * Classify an already-validated PAT for display metadata: `github_pat_` is a
   * fine-grained token, `ghp_` is a classic token.
   */
  tokenType(validatedToken: string): GitPatType {
    return validatedToken.startsWith('github_pat_')
      ? 'fine-grained'
      : 'classic';
  }
}
