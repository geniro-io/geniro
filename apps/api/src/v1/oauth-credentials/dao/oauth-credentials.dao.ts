import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { OAuthCredentialEntity } from '../entity/oauth-credential.entity';

@Injectable()
export class OAuthCredentialsDao extends BaseDao<OAuthCredentialEntity> {
  constructor(em: EntityManager) {
    super(em, OAuthCredentialEntity);
  }
}
