import { UnauthorizedException } from '@packages/common';
import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTVerifyOptions,
} from 'jose';

import type { IContextData } from '../auth.types';
import { AuthProvider } from './auth.provider';

export class KeycloakProvider extends AuthProvider {
  private realms: Map<
    string,
    {
      keyset: ReturnType<typeof createRemoteJWKSet>;
      verifyOptions: JWTVerifyOptions;
    }
  > = new Map();

  constructor(
    private readonly params: {
      url: string;
      realms: string[];
    },
  ) {
    super();
    this.init();
  }

  public init() {
    const { realms, url } = this.params;

    for (const _realm of realms || []) {
      const issuerUri = `${url}/realms/${_realm}`;
      const certsUri = `${issuerUri}/protocol/openid-connect/certs`;

      const keyset = createRemoteJWKSet(new URL(certsUri));
      const verifyOptions: JWTVerifyOptions = {
        issuer: issuerUri,
        algorithms: ['RS256'],
      };
      this.realms.set(issuerUri, { keyset, verifyOptions });
    }
  }

  public async verifyToken(token: string): Promise<IContextData> {
    try {
      const { iss } = decodeJwt(token);
      if (!iss) {
        throw new UnauthorizedException('UNAUTHORIZED', 'No issuer found');
      }
      const issuer = <string>iss;
      const realm = this.realms.get(issuer);
      if (!realm) {
        throw new UnauthorizedException('UNAUTHORIZED', 'No realm found');
      }
      const { keyset, verifyOptions } = realm;

      const { payload } = await jwtVerify(token, keyset, verifyOptions);

      const realmAccess = payload.realm_access as
        | { roles?: string[] }
        | undefined;
      const roles = Array.isArray(realmAccess?.roles)
        ? realmAccess.roles
        : undefined;

      return {
        sub: payload.sub,
        ...(roles && { roles }),
      };
    } catch (err) {
      throw new UnauthorizedException('UNAUTHORIZED', undefined, {
        customMessage: (<Error>err).message,
      });
    }
  }
}
