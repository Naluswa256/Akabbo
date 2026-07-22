import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@akabbo/prisma';

/** A Prisma client bound to an open transaction (RLS GUC already set). */
export type TenantTx = Prisma.TransactionClient;

/**
 * The single doorway to tenant-scoped data.
 *
 * Every read or write of an event-scoped table MUST go through `runInEvent`. It
 * opens a transaction, sets the transaction-local GUC `app.current_event_id`
 * that the RLS policies key on (§3.7), and runs the callback with that tenant
 * active. Outside this method, RLS matches no rows — so a forgotten scope fails
 * closed rather than leaking across events.
 *
 * Because it is a real transaction, it is also the atomic boundary the
 * invariants require: mutation + audit_event + outbox commit together or not at
 * all (§8 "Transactions are sacred").
 */
@Injectable()
export class TenantContext {
  constructor(private readonly prisma: PrismaService) {}

  runInEvent<T>(eventId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await TenantContext.setTenant(tx, eventId);
      return fn(tx);
    });
  }

  /**
   * Run a transaction where the tenant is established mid-flight — used by event
   * CREATION, where the `event` row (not itself RLS-scoped) must be inserted
   * before its id can scope the member/audit rows that follow. The callback
   * receives both the tx and a `setTenant` it must call once the event exists.
   */
  runCreatingEvent<T>(
    fn: (tx: TenantTx, setTenant: (eventId: string) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction((tx) =>
      fn(tx, (eventId) => TenantContext.setTenant(tx, eventId)),
    );
  }

  /**
   * Run a CROSS-EVENT read scoped to one USER ("My Events", §26). Tenant RLS
   * pins reads to a single event, which by construction cannot answer "every
   * event I belong to". This sets the narrower `app.current_user_id` GUC, which
   * the `event_member` policy honours for READS of your own membership rows
   * only — writes remain strictly event-scoped.
   */
  runAsUser<T>(userId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await TenantContext.setCurrentUser(tx, userId);
      return fn(tx);
    });
  }

  /** Set the transaction-local RLS GUC. is_local=true resets it at commit. */
  static async setTenant(tx: TenantTx, eventId: string): Promise<void> {
    await tx.$executeRaw`SELECT set_config('app.current_event_id', ${eventId}, true)`;
  }

  /** Transaction-local "who am I" GUC, for own-membership reads. */
  static async setCurrentUser(tx: TenantTx, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
  }

  /**
   * Run a CROSS-EVENT operation as the trusted WORKER (§7 outbox drain). Sets
   * `app.worker_mode`, which the outbox policy honours so the drain can see
   * PENDING rows across every event. User-facing code never calls this.
   */
  runAsWorker<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.worker_mode', 'on', true)`;
      return fn(tx);
    });
  }
}
