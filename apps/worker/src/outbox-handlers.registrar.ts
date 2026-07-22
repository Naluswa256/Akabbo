import { Injectable, OnModuleInit } from '@nestjs/common';
import { OutboxDrainService, OutboxMessage } from '@akabbo/ledger';
import { ExtractionService } from '@akabbo/documents';
import { SmsService } from '@akabbo/comms';

/**
 * Registers the worker's outbox topic handlers with the drain at boot
 * (blueprint §7). This is where recorded facts are bound to their side effects:
 * `document.uploaded` → multimodal extraction; `sms.campaign` → send the batch
 * via the provider (commit/refund each credit). Handlers MUST be idempotent — a
 * redelivered row runs again.
 */
@Injectable()
export class OutboxHandlersRegistrar implements OnModuleInit {
  constructor(
    private readonly drain: OutboxDrainService,
    private readonly extraction: ExtractionService,
    private readonly sms: SmsService,
  ) {}

  onModuleInit(): void {
    this.drain.register({
      'document.uploaded': async (msg: OutboxMessage) => {
        const payload = msg.payload as { documentId?: string };
        if (payload?.documentId) {
          await this.extraction.process(msg.eventId, payload.documentId);
        }
      },
      'sms.campaign': async (msg: OutboxMessage) => {
        const payload = msg.payload as { campaignId?: string };
        if (payload?.campaignId) {
          await this.sms.processCampaign(msg.eventId, payload.campaignId);
        }
      },
    });
  }
}
