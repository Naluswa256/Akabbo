/**
 * Sources whose own terms prohibit using their content to build an AI
 * system's knowledge — checked before ANY live-search result is ever passed
 * to extraction, no exceptions. Scribd's Global Terms of Use §9.1(a)
 * explicitly bars both scraping AND "training, fine-tuning, or otherwise
 * developing a large language model or similar artificial intelligence
 * system" with their content — automated or not, so a human reviewing a
 * live-search hit wouldn't make it any safer to use. Slideshare and Everand
 * are the same company under the same terms.
 */
const BLOCKED_HOSTS = ['scribd.com', 'slideshare.net', 'everand.com'];

export function isBlockedSource(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true; // an unparsable "URL" is not safe to trust either
  }
  return BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}
