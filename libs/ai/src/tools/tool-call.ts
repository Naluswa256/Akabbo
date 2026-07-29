import { z } from 'zod';

/**
 * The typed tool-call contract (CLAUDE.md §4). EVERY action-driving output —
 * from the deterministic tier-1 parser OR the LLM — is one of these, validated
 * against a schema. Malformed output is rejected, never half-parsed. Tools are
 * thin intents over the Phase-1 domain services; the AI gets no privileged path.
 *
 * Amounts are digit strings of integer minor units (already normalised by the
 * time a ToolCall exists — see parseAmountToMinorUnits).
 */

const amountString = z.string().regex(/^\d+$/, 'amount must be integer minor units');

export const addPersonArgs = z.object({
  displayName: z.string().min(1).max(200),
  /** Optional — captured when the user states it in the same breath, so the
   *  contributor is reachable by SMS from the moment they're added. */
  phone: z.string().min(1).max(20).optional(),
  /** Only pass true when the user has explicitly confirmed this phone is a
   *  genuinely shared/family number after being told it's already on file
   *  for someone else — never set this pre-emptively. */
  confirmSharedPhone: z.boolean().optional(),
});

export const recordPledgeArgs = z.object({
  personName: z.string().min(1),
  amount: amountString,
  type: z.enum(['CASH', 'ITEM', 'SERVICE']).optional(),
  /** Optional — set ONLY when the user states an amount already received in
   *  the SAME breath as the pledge ("pledged 1M, already paid 200k"). Records
   *  both atomically as one pledge with one fulfillment against it, never two
   *  separate pledges — see FulfillmentService.recordPledgeWithPayment. */
  receivedNow: amountString.optional(),
});

export const recordPaymentArgs = z.object({
  personName: z.string().min(1),
  amount: amountString,
  /** Optional — only meaningful when this turns out to have no existing
   *  pledge (a direct contribution): CASH/ITEM/SERVICE, mirroring
   *  record_pledge's `type`, so an in-kind gift ("gave 2 goats") isn't
   *  forced to look like a cash amount. */
  type: z.enum(['CASH', 'ITEM', 'SERVICE']).optional(),
  /** What the item/service actually is, for ITEM/SERVICE contributions. */
  description: z.string().min(1).max(500).optional(),
});

export const getOutstandingArgs = z.object({
  personName: z.string().min(1).optional(),
});

export const getSummaryArgs = z.object({});

/** Discriminated union of all tool calls, tagged by `tool`. */
export const toolCallSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('add_person'), args: addPersonArgs }),
  z.object({ tool: z.literal('record_pledge'), args: recordPledgeArgs }),
  z.object({ tool: z.literal('record_payment'), args: recordPaymentArgs }),
  z.object({ tool: z.literal('get_outstanding'), args: getOutstandingArgs }),
  z.object({ tool: z.literal('get_summary'), args: getSummaryArgs }),
]);

export type ToolCall = z.infer<typeof toolCallSchema>;
export type ToolName = ToolCall['tool'];

/** Tools that WRITE to the ledger (need entity resolution + gates + provenance). */
export const WRITE_TOOLS: ReadonlySet<ToolName> = new Set([
  'add_person',
  'record_pledge',
  'record_payment',
]);

/** Tools that only READ (numbers come from SQL; the model just phrases them). */
export const READ_TOOLS: ReadonlySet<ToolName> = new Set(['get_outstanding', 'get_summary']);

/**
 * JSON-Schema tool specs handed to the LLM (structured-output/tool-calling).
 * Kept in sync with the zod schemas above by hand — small and stable.
 */
export const LLM_TOOL_SPECS = [
  {
    name: 'add_person',
    description: 'Add a new contributor (person) to the event.',
    parameters: {
      type: 'object',
      properties: {
        displayName: { type: 'string' },
        phone: { type: 'string', description: 'Optional — capture it if the user states it.' },
        confirmSharedPhone: {
          type: 'boolean',
          description: 'Only true if the user confirmed this phone is genuinely shared/family after being told it is already on file for someone else.',
        },
      },
      required: ['displayName'],
    },
  },
  {
    name: 'record_pledge',
    description:
      'Record a pledge (a promise to contribute) by a named person. If the SAME message also says how much they\'ve already paid ' +
      '(e.g. "pledged 1M, has paid 200k so far"), ALWAYS pass that as `receivedNow` here too — never call record_payment separately ' +
      'in the same turn for a pledge just created in this call, since it cannot see the pledge until this is confirmed.',
    parameters: {
      type: 'object',
      properties: {
        personName: { type: 'string' },
        amount: { type: 'string', description: 'integer minor units, digits only' },
        type: { type: 'string', enum: ['CASH', 'ITEM', 'SERVICE'] },
        receivedNow: {
          type: 'string',
          description: 'Optional — amount already paid toward this pledge, integer minor units, digits only.',
        },
      },
      required: ['personName', 'amount'],
    },
  },
  {
    name: 'record_payment',
    description:
      "Record a payment that discharges a named person's pledge. If the person has no " +
      'existing pledge, this records a direct contribution instead — pass `type` ' +
      "(ITEM/SERVICE) and `description` when it's an in-kind gift, not cash.",
    parameters: {
      type: 'object',
      properties: {
        personName: { type: 'string' },
        amount: { type: 'string', description: 'integer minor units, digits only' },
        type: { type: 'string', enum: ['CASH', 'ITEM', 'SERVICE'] },
        description: { type: 'string', description: 'What the item/service is, for ITEM/SERVICE.' },
      },
      required: ['personName', 'amount'],
    },
  },
  {
    name: 'get_outstanding',
    description: 'Get the outstanding balance for a person, or the whole event.',
    parameters: {
      type: 'object',
      properties: { personName: { type: 'string' } },
    },
  },
  {
    name: 'get_summary',
    description: 'Get overall event totals (committed, fulfilled, outstanding).',
    parameters: { type: 'object', properties: {} },
  },
] as const;
