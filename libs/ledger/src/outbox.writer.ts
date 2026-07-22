import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantTx } from './tenant-context.service';

export interface OutboxInput {
  eventId: string;
  topic: string;
  payload: Prisma.InputJsonValue;
  /**
   * Ties the message to its originating row so a retry never double-sends
   * (§3.5). Unique in the DB; a duplicate enqueue is swallowed as a no-op.
   */
  idempotencyKey: string;
}

/**
 * Writes transactional-outbox rows (§5). Enqueued inside the mutation's
 * transaction; drained by the worker from Phase 3. In Phase 1 nothing consumes
 * these yet — we write them so the seam is real and the fan-out is a pure add.
 */
@Injectable()
export class OutboxWriter {
  async enqueue(tx: TenantTx, input: OutboxInput): Promise<void> {
    try {
      await tx.outbox.create({
        data: {
          eventId: input.eventId,
          topic: input.topic,
          payload: input.payload,
          idempotencyKey: input.idempotencyKey,
        },
      });
    } catch (err) {
      // Unique-violation on idempotencyKey → already enqueued → no-op.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return;
      }
      throw err;
    }
  }
}
