import { Injectable } from '@nestjs/common';
import { TenantContext } from '@akabbo/ledger';

export interface PersonCandidate {
  personId: string;
  displayName: string;
}

export type PersonResolution =
  | { status: 'resolved'; personId: string; displayName: string }
  | { status: 'ambiguous'; candidates: PersonCandidate[] }
  | { status: 'none' };

export interface PledgeCandidate {
  pledgeId: string;
  committedValue: string;
}

export type PledgeResolution =
  | { status: 'resolved'; pledgeId: string }
  | { status: 'ambiguous'; candidates: PledgeCandidate[] }
  | { status: 'none' };

export type FulfillmentResolution =
  | { status: 'resolved'; fulfillmentId: string; unallocated: bigint }
  | { status: 'none' };

/**
 * Resolves a person NAME to a person_id within ONE event (CLAUDE.md §4:
 * "Entity resolution is scoped to the event"). Ambiguity ("which John?")
 * triggers a clarifying question — it NEVER guesses. Runs under the event's RLS
 * scope, so it can only ever see this event's people.
 */
@Injectable()
export class EntityResolver {
  constructor(private readonly tenant: TenantContext) {}

  resolvePerson(eventId: string, name: string): Promise<PersonResolution> {
    const needle = name.trim();
    return this.tenant.runInEvent(eventId, async (tx) => {
      const matches = await tx.person.findMany({
        where: { displayName: { contains: needle, mode: 'insensitive' } },
        select: { id: true, displayName: true },
        orderBy: { createdAt: 'asc' },
      });

      if (matches.length === 0) return { status: 'none' };
      if (matches.length === 1) {
        return { status: 'resolved', personId: matches[0].id, displayName: matches[0].displayName };
      }

      // Multiple partial matches — prefer a single exact (case-insensitive) hit.
      const exact = matches.filter((m) => m.displayName.toLowerCase() === needle.toLowerCase());
      if (exact.length === 1) {
        return { status: 'resolved', personId: exact[0].id, displayName: exact[0].displayName };
      }

      return {
        status: 'ambiguous',
        candidates: matches.map((m) => ({ personId: m.id, displayName: m.displayName })),
      };
    });
  }

  /**
   * Resolve which pledge a payment discharges: a person's single active
   * (non-cancelled) pledge. Zero or many → the caller must ask, never guess.
   */
  resolvePledgeForPerson(eventId: string, personId: string): Promise<PledgeResolution> {
    return this.tenant.runInEvent(eventId, async (tx) => {
      const pledges = await tx.pledge.findMany({
        where: { personId, status: { not: 'CANCELLED' } },
        select: { id: true, committedValue: true },
        orderBy: { createdAt: 'asc' },
      });
      if (pledges.length === 0) return { status: 'none' };
      if (pledges.length === 1) return { status: 'resolved', pledgeId: pledges[0].id };
      return {
        status: 'ambiguous',
        candidates: pledges.map((p) => ({
          pledgeId: p.id,
          committedValue: p.committedValue.toString(),
        })),
      };
    });
  }

  /**
   * Which of a person's payments has money left to earmark against a budget
   * item (§13 allocation). Picks the most recent payment with unallocated
   * value remaining — "allocate the payment we just talked about" is the
   * overwhelmingly common chat pattern, so we auto-pick rather than forcing a
   * disambiguation round-trip for what is usually obvious from context.
   */
  resolveUnallocatedFulfillmentForPerson(
    eventId: string,
    personId: string,
  ): Promise<FulfillmentResolution> {
    return this.tenant.runInEvent(eventId, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; unallocated: bigint }[]>`
        SELECT f.id,
               (f.value - COALESCE((SELECT SUM(a.value) FROM allocation a WHERE a.fulfillment_id = f.id), 0))::bigint AS unallocated
        FROM fulfillment f
        JOIN pledge pl ON f.pledge_id = pl.id
        WHERE pl.person_id = ${personId}::uuid AND pl.status <> 'CANCELLED'
        ORDER BY f.occurred_at DESC
      `;
      const candidate = rows.find((r) => r.unallocated > 0n);
      if (!candidate) return { status: 'none' };
      return { status: 'resolved', fulfillmentId: candidate.id, unallocated: candidate.unallocated };
    });
  }
}
