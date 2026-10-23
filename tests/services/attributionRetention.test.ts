import { maintainAttributionRetention } from '../../src/services/attributionRetention.js';

test('maintenance coalesces requests, waits for its interval and uses a bounded batch', async () => {
  jest.useFakeTimers();
  const previous = process.env.MCPHUB_ATTRIBUTION_RETENTION_DAYS;
  process.env.MCPHUB_ATTRIBUTION_RETENTION_DAYS = '30';
  const calls: Array<{ cutoff: Date; limit: number | undefined }> = [];
  const repository = { pruneExpired: async (cutoff: Date, limit?: number) => {
    calls.push({ cutoff, limit });
    return 0;
  } };
  try {
    maintainAttributionRetention(repository);
    maintainAttributionRetention(repository);
    expect(calls).toHaveLength(1);
    expect(calls[0].limit).toBe(500);
    expect(Date.now() - calls[0].cutoff.getTime()).toBe(30 * 86400000);
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(3600000);
    maintainAttributionRetention(repository);
    expect(calls).toHaveLength(2);
  } finally {
    jest.useRealTimers();
    if (previous === undefined) delete process.env.MCPHUB_ATTRIBUTION_RETENTION_DAYS;
    else process.env.MCPHUB_ATTRIBUTION_RETENTION_DAYS = previous;
  }
});
