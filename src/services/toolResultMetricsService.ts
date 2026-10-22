export interface ToolResultRetrievalMetrics {
  searches: number;
  hybridSearches: number;
  lexicalFallbacks: number;
  indexAttempts: number;
  indexFailures: number;
}

const metrics: ToolResultRetrievalMetrics = {
  searches: 0,
  hybridSearches: 0,
  lexicalFallbacks: 0,
  indexAttempts: 0,
  indexFailures: 0,
};

export const recordToolResultSearch = (mode: 'hybrid' | 'lexical'): void => {
  metrics.searches += 1;
  if (mode === 'hybrid') metrics.hybridSearches += 1;
  else metrics.lexicalFallbacks += 1;
};

export const recordToolResultIndexAttempt = (): void => { metrics.indexAttempts += 1; };
export const recordToolResultIndexFailure = (): void => { metrics.indexFailures += 1; };
export const getToolResultRetrievalMetrics = (): ToolResultRetrievalMetrics => ({ ...metrics });

