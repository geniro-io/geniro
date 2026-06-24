import { Module } from '@nestjs/common';

import { GitAuthModule } from '../git-auth/git-auth.module';
import { SecretsStoreModule } from '../secrets-store/secrets-store.module';
import { SystemController } from './system.controller';

@Module({
  imports: [GitAuthModule, SecretsStoreModule],
  controllers: [SystemController],
})
export class SystemModule {}
