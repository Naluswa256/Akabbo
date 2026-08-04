import { parseTier1 } from './tier1-parser';

describe('parseTier1 (deterministic, $0 capture)', () => {
  it('parses a payment utterance', () => {
    expect(parseTier1('John paid 200k')).toEqual({
      tool: 'record_payment',
      args: { personName: 'John', amount: '200000' },
    });
  });

  it('parses a payment with trailing context and currency', () => {
    expect(parseTier1('John Okello sent UGX 500,000 toward catering')).toEqual({
      tool: 'record_payment',
      args: { personName: 'John Okello', amount: '500000' },
    });
  });

  it('parses a pledge utterance', () => {
    expect(parseTier1('Mary pledged 1.5m')).toEqual({
      tool: 'record_pledge',
      args: { personName: 'Mary', amount: '1500000' },
    });
  });

  it('parses add-person', () => {
    expect(parseTier1('add Peter Mubiru')).toEqual({
      tool: 'add_person',
      args: { displayName: 'Peter Mubiru' },
    });
  });

  it('parses summary and outstanding reads', () => {
    expect(parseTier1('summary')?.tool).toBe('get_summary');
    expect(parseTier1('who owes?')?.tool).toBe('get_outstanding');
    expect(parseTier1('how much does John owe')).toEqual({
      tool: 'get_outstanding',
      args: { personName: 'John' },
    });
  });

  it('returns null (escalate to LLM) for ambiguous/unshaped input', () => {
    expect(parseTier1('what did we discuss about the tents last week')).toBeNull();
    expect(parseTier1('John paid some money')).toBeNull(); // no parseable amount
    expect(parseTier1('')).toBeNull();
  });

  it('escalates "<quantity> [unit] of <description>" instead of mis-parsing it as cash', () => {
    // Real production bug: buildUtterance's phrasing for document-scanned
    // in-kind rows was being read as a cash amount. Two distinct failures
    // this must not reproduce:
    //  - "2 mats" → the space-before-suffix regex read the leading "m" of
    //    "mats" as the million shorthand, staging a pledge of 2,000,000.
    //  - "2 goats" → no k/m false hit, but still wrongly staged as UGX 2
    //    cash instead of an in-kind quantity.
    expect(parseTier1('Kiwanuka Richard pledged 2 mats of traditional mats')).toBeNull();
    expect(parseTier1('Mugabo Emmanuel pledged 2 goats of goats')).toBeNull();
  });

  it('does not let a unit-like word starting with k/m inflate a nearby amount', () => {
    // Without the "of" phrasing this still parses as a (probably wrong) cash
    // amount — a separate, pre-existing tier1 limitation (it only handles
    // cash) that isn't what this fix targets. What must never happen again:
    // "mattresses" starting with "m" inflating "2" into 2,000,000 the way
    // the old space-tolerant k/m regex did.
    expect(parseTier1('Grace pledged 2 mattresses')).toEqual({
      tool: 'record_pledge',
      args: { personName: 'Grace', amount: '2' },
    });
  });

  it('still parses genuine cash amounts with trailing context', () => {
    expect(parseTier1('John Okello sent UGX 500,000 toward catering')).toEqual({
      tool: 'record_payment',
      args: { personName: 'John Okello', amount: '500000' },
    });
    expect(parseTier1('Mary pledged 1.5m')).toEqual({
      tool: 'record_pledge',
      args: { personName: 'Mary', amount: '1500000' },
    });
  });
});
