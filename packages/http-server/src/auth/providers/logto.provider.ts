import { UnauthorizedException } from '@packages/common';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyOptions } from 'jose';

import type { IContextData } from '../auth.types';
import { AuthProvider } from './auth.provider';

export class LogtoProvider extends AuthProvider {
  private keyset: ReturnType<typeof createRemoteJWKSet>;
  private verifyOptions: JWTVerifyOptions;

  constructor(private readonly domain: string) {
    super();
    const issuer = `https://${domain}/oidc`;
    const jwksUri = `${issuer}/jwks`;
    this.keyset = createRemoteJWKSet(new URL(jwksUri));
    this.verifyOptions = {
      issuer,
      algorithms: ['ES384'],
    };
  }

  public async verifyToken(token: string): Promise<IContextData> {
    try {
      const { payload } = await jwtVerify(
        token,
        this.keyset,
        this.verifyOptions,
      );
      return {
        sub: payload.sub,
      };
    } catch (err) {
      throw new UnauthorizedException('UNAUTHORIZED', undefined, {
        customMessage: (<Error>err).message,
      });
    }
  }
}
