import { UnauthorizedException } from '@packages/common';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyOptions } from 'jose';

import type { IContextData } from '../auth.types';
import { AuthProvider } from './auth.provider';

export class ZitadelProvider extends AuthProvider {
  private keyset: ReturnType<typeof createRemoteJWKSet>;
  private verifyOptions: JWTVerifyOptions;

  constructor(
    private readonly params: {
      url: string;
      issuer: string;
    },
  ) {
    super();
    const jwksUri = `${params.url}/oauth/v2/keys`;
    this.keyset = createRemoteJWKSet(new URL(jwksUri));
    this.verifyOptions = {
      issuer: params.issuer,
      algorithms: ['RS256'],
    };
  }

  public async verifyToken(token: string): Promise<IContextData> {
    try {
      const { payload } = await jwtVerify(
        token,
        this.keyset,
        this.verifyOptions,
      );

      if (!payload.sub) {
        throw new UnauthorizedException('UNAUTHORIZED', undefined, {
          customMessage: 'Token missing required sub claim',
        });
      }

      const projectRoles = payload['urn:zitadel:iam:org:project:roles'] as
        | Record<string, unknown>
        | undefined;
      const roles = projectRoles ? Object.keys(projectRoles) : undefined;

      return {
        sub: payload.sub,
        ...(roles && { roles }),
      };
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      throw new UnauthorizedException('UNAUTHORIZED', undefined, {
        customMessage: (<Error>err).message,
      });
    }
  }
}
