/**
 * The closed catalog of authorizable actions. Every mutating or sensitive-read
 * operation maps to exactly one of these, and the permission matrix
 * (permission.service) decides which roles may perform each. Keeping this a
 * closed union means a new operation cannot silently ship without a deliberate
 * permission decision.
 */
export const ACTIONS = [
  // Event & membership (Identity & Access)
  'event:read',
  'event:update',
  'member:manage',
  // Ledger writes
  'person:write',
  // Merging duplicate people re-parents financial history — a sensitive write
  // kept distinct from ordinary person edits (next-increment §4).
  'person:merge',
  'pledge:write',
  'pledge:cancel',
  'fulfillment:write',
  'fulfillment:correct',
  // Ledger reads — split for finance privacy (blueprint §12): a VIEWER may see
  // the redacted funding summary ("72% funded") but NOT the underlying amounts.
  // `ledger:read_amounts` gates every read that returns money; the redacted
  // funding view (read_funding) is a Phase-6 reporting surface — the permission
  // exists now so the split is not a retrofit.
  'ledger:read_funding',
  'ledger:read_amounts',
  // Budget (§8 VIEW_BUDGET / EDIT_BUDGET). Budget lines are PLANNED SPEND, not
  // contributor amounts, so reading them is broader than `read_amounts` — §9
  // explicitly wants a coordinator who may only "view the budget".
  'budget:read',
  'budget:write',
  // Contributor groups / family sides (next-increment §9). Reading a group's
  // membership is broad (like the budget); group amounts still need read_amounts.
  'group:read',
  'group:write',
  // Documents & Extraction (Phase 4, blueprint §2.4)
  'document:upload',
  'document:read',
  // Public transparency layer (transparency spec). The PUBLIC read surface is
  // UNAUTHENTICATED and gated by slug+token, NOT by any of these — these gate
  // the ORGANIZER-side management of what the public sees. `public:configure`
  // is the sensitive switch (who can see the event, revoke the link); the
  // announcement/payment-instruction actions are day-to-day coordination.
  'public:configure',
  'announcement:read',
  'announcement:write',
  'payment_instruction:read',
  'payment_instruction:write',
  // Communications (blueprint §2.4). Sending SMS spends credits + reaches
  // people — a SIDE EFFECT, so it's owner/coordinator-tier, distinct from read.
  'sms:send',
  'sms:read',
] as const;

export type Action = (typeof ACTIONS)[number];
