import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global Prisma module. One client, shared everywhere. The repository seam the
 * blueprint asks for (§8) lives above this — domain code depends on repository
 * interfaces, not on PrismaService directly, so a later DB move stays cheap.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
