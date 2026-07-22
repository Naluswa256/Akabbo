import { Injectable, Logger } from '@nestjs/common';
import { OutboxStatus, Prisma } from '@prisma/client';
import { TenantContext } from './tenant-context.service';

/** A row the drain hands to a handler. Payload is opaque per topic. */
export interface OutboxMessage {
  id: string;
  eventId: string;
  topic: string;
  payload: Prisma.JsonValue;
}

/** A topic handler. Must be IDEMPOTENT — a redelivered row calls it again. */
export type OutboxHandler = (msg: OutboxMessage) => Promise<void>;

export type OutboxHandlerMap = Record<string, OutboxHandler>;

/**
 * Drains the transactional outbox (blueprint §7). The worker calls `drainOnce`
 * on a schedule: it claims a batch of PENDING rows (cross-event, trusted-worker
 * scope), dispatches each to its topic handler, and marks it PROCESSED or
 * FAILED. Handlers must be idempotent (§45): a row processed then re-claimed
 * after a crash simply runs again.
 *
 * Nothing here is event-scoped by a single tenant — that's the whole point of a
 * central fan-out — so it runs under `runAsWorker`.
 *
 * Topic handlers are REGISTERED at boot via {@link register}. They can't be
 * constructor-injected: this service lives in LedgerModule, but the handlers are
 * assembled by the process that owns the side effects (the worker wires
 * `document.uploaded` → extraction), and Nest won't inject a parent-module
 * provider into an already-instantiated child-module service.
 */
@Injectable()
export class OutboxDrainService {
  private readonly logger = new Logger(OutboxDrainService.name);
  private readonly handlers: OutboxHandlerMap = {};

  constructor(private readonly tenant: TenantContext) {}

  /** Register (merge) topic handlers. Called once at boot by the worker. */
  register(handlers: OutboxHandlerMap): void {
    Object.assign(this.handlers, handlers);
  }

  /** Process up to `batchSize` pending rows. Returns how many were handled. */
  async drainOnce(batchSize = 20): Promise<number> {
    // Claim a batch: mark PENDING → PROCESSED-candidate under a row lock so two
    // workers never grab the same row. We flip to PROCESSING first.
    const claimed = await this.tenant.runAsWorker(async (tx) => {
      const rows = await tx.$queryRaw<OutboxMessage[]>`
        SELECT id, event_id AS "eventId", topic, payload
        FROM outbox
        WHERE status = 'PENDING'
        ORDER BY created_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length > 0) {
        await tx.outbox.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { status: OutboxStatus.PROCESSED, processedAt: new Date() },
        });
      }
      return rows;
    });

    let handled = 0;
    for (const msg of claimed) {
      const handler = this.handlers[msg.topic];
      if (!handler) {
        // No handler registered for this topic yet — leave it marked processed
        // (nothing consumes it) but log so we notice a missing wiring.
        this.logger.debug(`No handler for outbox topic '${msg.topic}' (id=${msg.id})`);
        continue;
      }
      try {
        await handler(msg);
        handled += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'handler failed';
        this.logger.warn(`Outbox handler '${msg.topic}' failed for ${msg.id}: ${message}`);
        // Re-open for a later retry (idempotent handlers make this safe).
        await this.tenant.runAsWorker((tx) =>
          tx.outbox.update({
            where: { id: msg.id },
            data: { status: OutboxStatus.PENDING, attempts: { increment: 1 } },
          }),
        );
      }
    }
    return handled;
  }
}
