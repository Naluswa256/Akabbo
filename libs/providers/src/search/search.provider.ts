/**
 * Web-search provider interface (budget intelligence — pre-budgeting).
 *
 * Behind the same provider-interface discipline as every other external
 * dependency (CLAUDE.md §2.1): domain code depends on THIS interface only,
 * never a vendor SDK. This is also the ONE seam in the whole app that touches
 * the open internet on the model's behalf — kept narrow and swappable
 * on purpose.
 */
export interface SearchResult {
  title: string;
  url: string;
  /** Short snippet always present. */
  snippet: string;
  /** Fuller extracted page text, when the provider offers it — reduces the
   *  need for a separate fetch step before extraction. */
  content?: string;
  /** ISO-8601 date if the provider/source states one. */
  publishedAt?: string;
}

export interface SearchOptions {
  maxResults?: number;
}

export interface SearchProvider {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}
