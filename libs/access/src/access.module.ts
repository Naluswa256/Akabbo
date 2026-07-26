import { Global, Module } from '@nestjs/common';
import { PermissionService } from './permission.service';
import { EntitlementService } from './entitlement.service';
import { AdminUsersService } from './admin-users.service';

/**
 * The two deterministic gates (§3.6), available everywhere. Permission
 * (authorization) and Entitlement (plan/credits) are separate services by
 * design so they can evolve independently — entitlement gets its real body in
 * Phase 5 while permission is complete now. AdminUsersService is the
 * read-only cross-user reporting surface built on top of EntitlementService.
 */
@Global()
@Module({
  providers: [PermissionService, EntitlementService, AdminUsersService],
  exports: [PermissionService, EntitlementService, AdminUsersService],
})
export class AccessModule {}
