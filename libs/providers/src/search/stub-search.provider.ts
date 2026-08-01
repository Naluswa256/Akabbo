import { Injectable } from '@nestjs/common';
import { ProviderNotImplementedError } from '../provider.errors';
import { SearchOptions, SearchProvider, SearchResult } from './search.provider';

/** Default stub — fails loud if invoked. Real adapter activates only when
 *  SEARCH_PROVIDER + SEARCH_API_KEY are configured (see providers.module.ts). */
@Injectable()
export class StubSearchProvider implements SearchProvider {
  readonly name = 'stub';

  search(_query: string, _options?: SearchOptions): Promise<SearchResult[]> {
    throw new ProviderNotImplementedError(
      'SearchProvider',
      'search',
      'budget intelligence live search (set SEARCH_PROVIDER + SEARCH_API_KEY)',
    );
  }
}
