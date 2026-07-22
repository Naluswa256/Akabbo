import { Global, Module } from '@nestjs/common';
import { PermissionService } from './permission.service';
import { EntitlementService } from './entitlement.service';

/**
 * The two deterministic gates (§3.6), available everywhere. Permission
 * (authorization) and Entitlement (plan/credits) are separate services by
 * design so they can evolve independently — entitlement gets its real body in
 * Phase 5 while permission is complete now.
 */
@Global()
@Module({
  providers: [PermissionService, EntitlementService],
  exports: [PermissionService, EntitlementService],
})
export class AccessModule {}
