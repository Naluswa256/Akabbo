import { Logger } from '@nestjs/common';
import { SearchOptions, SearchProvider, SearchResult } from './search.provider';

export interface TavilySearchConfig {
  apiKey: string;
}

interface TavilyResponseItem {
  title: string;
  url: string;
  content?: string;
  published_date?: string;
}

interface TavilyResponse {
  results?: TavilyResponseItem[];
}

/**
 * Tavily (tavily.com) — search API built for feeding LLM agents, chosen over
 * a raw SERP wrapper because it already returns extracted page content
 * (`content`), cutting out a separate fetch step per result. 1,000 free
 * searches/month, no card required — enough to validate this feature before
 * any spend commitment. See docs/pre-budgeting exploration §7 for the
 * pricing comparison this choice was based on.
 */
export class TavilySearchProvider implements SearchProvider {
  readonly name = 'tavily';
  private readonly logger = new Logger(TavilySearchProvider.name);

  constructor(private readonly config: TavilySearchConfig) {}

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: this.config.apiKey,
        query,
        max_results: options?.maxResults ?? 5,
        search_depth: 'basic',
        include_raw_content: false,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Tavily search failed (HTTP ${res.status}): ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as TavilyResponse;
    const results = (body.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: (r.content ?? '').slice(0, 300),
      content: r.content,
      publishedAt: r.published_date,
    }));
    this.logger.log(`Tavily search "${query}": ${results.length} result(s)`);
    return results;
  }
}
