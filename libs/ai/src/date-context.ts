/**
 * The model has no inherent sense of "now" — without this it guesses the year
 * (e.g. creating a "next October" event in the wrong year). Injecting today's
 * date (Uganda time) into the system prompt lets it resolve relative dates and
 * NEVER ask what year it is. Lives in its own module so both the capture and
 * assistant services can use it without an import cycle.
 */
export function currentDateNote(timeZone = 'Africa/Kampala'): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  return (
    `CURRENT DATE: today is ${get('weekday')}, ${date} (timezone ${timeZone}). ` +
    `Resolve every relative date — "this year", "next month", "October 2nd", "next Saturday" — ` +
    `against this. The current year is ${get('year')}. NEVER ask the user what year or what today's date is.`
  );
}
