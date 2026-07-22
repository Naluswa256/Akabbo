import { Global, Module } from '@nestjs/common';
import { AppConfigService } from './config.service';
import { validateEnv } from './env.schema';

/**
 * Global config module. Validates the environment ONCE at boot (fail-closed)
 * and exposes a typed {@link AppConfigService} everywhere.
 */
@Global()
@Module({
  providers: [
    {
      provide: AppConfigService,
      useFactory: () => new AppConfigService(validateEnv()),
    },
  ],
  exports: [AppConfigService],
})
export class AppConfigModule {}
