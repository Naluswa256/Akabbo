import { Injectable } from '@nestjs/common';
import { Prisma, UsageKind } from '@prisma/client';
import { TenantContext } from '@akabbo/ledger';
import { LlmUsage } from '@akabbo/providers';

/**
 * Writes the append-only usage_event meter (metering doc §7.1–§7.3). AI is
 * metered for OBSERVABILITY only — cost attribution + abuse detection — and is
 * NEVER a billing gate. Cost is stored in integer micro-USD (no floats).
 */
@Injectable()
export class UsageMeter {
  constructor(private readonly tenant: TenantContext) {}

  /** Record one LLM call's tokens, model, and computed cost. */
  async recordLlmCall(
    eventId: string,
    usage: LlmUsage,
    costMicroUsd: bigint,
    meta?: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.tenant.runInEvent(eventId, async (tx) => {
      await tx.usageEvent.create({
        data: {
          eventId,
          kind: UsageKind.llm_call,
          quantity: 1,
          tokensIn: usage.inputTokens,
          tokensOut: usage.outputTokens,
          model: usage.model,
          costMicroUsd,
          meta,
        },
      });
    });
  }
}
