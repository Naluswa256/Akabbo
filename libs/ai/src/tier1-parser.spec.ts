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
});
