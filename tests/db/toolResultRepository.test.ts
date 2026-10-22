import { ToolResultRepositoryDb } from '../../src/db/repositories/ToolResultRepository.js';

describe('ToolResultRepositoryDb', () => {
  it('creates the immutable result and mutable state atomically', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const repository = new ToolResultRepositoryDb({ query } as never);

    await repository.create({
      resultId: 'result-1', timestamp: new Date('2026-10-22T00:00:00Z'), server: 'srv',
      tool: 'tool', durationMs: 10, status: 'success', arguments: '{}', raw: '{}',
      rawText: '{}', rawBytes: 2, rawSha256: 'hash', payloadAvailable: true,
      pinned: false, useCount: 0,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('WITH inserted AS');
    expect(query.mock.calls[0][0]).toContain('INSERT INTO tool_result_state');
  });

  it('retains the newest unpinned records in a deterministic order', async () => {
    const query = jest.fn().mockResolvedValue([{ result_id: 'removed' }]);
    const repository = new ToolResultRepositoryDb({ query } as never);

    const deleted = await repository.enforceRetention(10_000, 'tommi');

    expect(deleted).toBe(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('state.pinned = FALSE');
    expect(sql).toContain('ORDER BY result.timestamp DESC, result.result_id DESC');
    expect(sql).toContain('OFFSET $1');
    expect(params).toEqual([10_000, 'tommi']);
  });

  it('uses parameterized lexical search over metadata and RAW text', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const repository = new ToolResultRepositoryDb({ query } as never);

    await repository.search('Xid 79', 25, { server: 'desktop-commander' });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('websearch_to_tsquery');
    expect(sql).toContain('result.raw_text');
    expect(sql).not.toContain('Xid 79');
    expect(params).toContain('Xid 79');
    expect(params).toContain('desktop-commander');
  });
});
