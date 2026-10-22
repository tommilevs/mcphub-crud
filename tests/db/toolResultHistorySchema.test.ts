import { ensureToolResultHistorySchema } from '../../src/db/toolResultHistorySchema.js';

describe('ensureToolResultHistorySchema', () => {
  it('creates immutable RAW storage, mutable state, indexes, and update protection', async () => {
    const query = jest.fn().mockResolvedValue([]);

    await ensureToolResultHistorySchema({ query } as never);

    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS tool_results');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS tool_result_state');
    expect(sql).toContain('raw_sha256');
    expect(sql).toContain('payload_available');
    expect(sql).toContain('CREATE TRIGGER tool_results_immutable');
    expect(sql).toContain('BEFORE UPDATE ON tool_results');
    expect(sql).toContain('tool_results_search_idx');
  });
});
