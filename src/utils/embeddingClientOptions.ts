import type { ClientOptions } from 'openai';

/** The SDK requires a nonempty key even for unauthenticated local providers.
 * Keep its internal placeholder out of both persisted settings and HTTP headers. */
export function embeddingClientOptions(config: {apiKey?: string; baseURL?: string}): ClientOptions {
  const apiKey = config.apiKey?.trim();
  return {
    apiKey: apiKey || 'mcphub-local-no-auth',
    baseURL: config.baseURL,
    ...(!apiKey ? {defaultHeaders: {Authorization: null}, organization: null, project: null} : {}),
  };
}
