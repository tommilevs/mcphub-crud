import { ToolResultRepositoryDb } from '../../src/db/repositories/ToolResultRepository.js';

describe('ToolResultRepositoryDb', () => {
  it('filters attribution fields using parameters instead of interpolating claims', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const repository = new ToolResultRepositoryDb({ query } as never);
    await repository.search('evidence', 10, { modelId: "model'claim", traceId: 'trace-one', taskId: 'task-one' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("result.attribution->'identity'->>'modelId'");
    expect(sql).toContain("result.attribution->>'traceId'");
    expect(sql).not.toContain("model'claim");
    expect(params).toEqual(["model'claim", 'task-one', 'trace-one', 'evidence', 10]);
  });
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

  it('filters a timeline by session without interpolating its identifier', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: '0' }]);
    const repository = new ToolResultRepositoryDb({ query } as never);

    await repository.findPaginated(1, 20, { sessionId: 'session-42' });

    expect(query.mock.calls[0][0]).toContain('result.session_id = $1');
    expect(query.mock.calls[0][0]).not.toContain('session-42');
    expect(query.mock.calls[0][1]).toEqual(['session-42', 20, 0]);
  });

  it('stores a derived vector index separately from immutable RAW', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const repository = new ToolResultRepositoryDb({ query } as never);

    await repository.indexContent('result-1', 'searchable evidence', [0.1, 0.2]);

    expect(query.mock.calls[0][0]).toContain('INSERT INTO tool_result_chunks');
    expect(query.mock.calls[0][0]).not.toContain('UPDATE tool_results');
    expect(query.mock.calls[0][1]).toEqual(['result-1', 'searchable evidence', '[0.1,0.2]']);
  });

  it('combines lexical and vector ranks with reciprocal-rank fusion', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const repository = new ToolResultRepositoryDb({ query } as never);

    await repository.hybridSearch('failed deployment', [0.3, 0.4], 10, { status: 'error' });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('websearch_to_tsquery');
    expect(sql).toContain('embedding <=>');
    expect(sql).toContain('retrieval_score');
    expect(params).toEqual(['error', 'failed deployment', '[0.3,0.4]', 10]);
  });

  it('replaces derived chunks without touching immutable RAW', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const repository = new ToolResultRepositoryDb({ query } as never);

    await repository.indexChunks('result-1', [
      { chunkIndex: 0, chunkVersion: 1, content: 'first', embedding: null },
      { chunkIndex: 1, chunkVersion: 1, content: 'second', embedding: [0.1, 0.2] },
    ]);

    expect(query.mock.calls[0][0]).toContain('DELETE FROM tool_result_chunks');
    expect(query.mock.calls[0][0]).toContain('INSERT INTO tool_result_chunks');
    expect(JSON.parse(query.mock.calls[0][1][1])[1]).toEqual({chunk_index:1,chunk_version:1,content:'second',embedding:'[0.1,0.2]'});
    expect(query.mock.calls.map(([sql]) => sql).join('\n')).not.toContain('UPDATE tool_results');
  });

  it('searches chunks inside one result with fused ranks', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const repository = new ToolResultRepositoryDb({ query } as never);

    await repository.searchChunks('result-1', 'Xid 79', [0.1, 0.2], 5);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('chunks.result_id = $1');
    expect(sql).toContain('vector_dims(embedding) = vector_dims($3::vector)');
    expect(sql).toContain('retrieval_score');
    expect(params).toEqual(['result-1', 'Xid 79', '[0.1,0.2]', 5]);
  });

  it('lists exact indexed chunks with embedding metadata', async () => {
    const query = jest.fn().mockResolvedValue([
      { result_id: 'result-1', chunk_index: '0', chunk_version: '1', content: 'first', content_bytes: 5, has_embedding: false, embedding_dimensions: null },
      { result_id: 'result-1', chunk_index: '1', chunk_version: '1', content: 'second', content_bytes: 6, has_embedding: true, embedding_dimensions: 2 },
    ]);
    const repository = new ToolResultRepositoryDb({ query } as never);

    await expect(repository.listChunks('result-1')).resolves.toEqual([
      { resultId: 'result-1', chunkIndex: 0, chunkVersion: 1, content: 'first', contentBytes: 5, hasEmbedding: false, embeddingDimensions: undefined },
      { resultId: 'result-1', chunkIndex: 1, chunkVersion: 1, content: 'second', contentBytes: 6, hasEmbedding: true, embeddingDimensions: 2 },
    ]);
    expect(query.mock.calls[0][1]).toEqual(['result-1']);
  });

  it('selects only payload-bearing results for safe derived-index rebuilds', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const repository = new ToolResultRepositoryDb({ query } as never);

    await repository.findForReindex(25, true);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('result.payload_available = TRUE');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('tool_result_chunks');
    expect(params).toEqual([25, true]);
  });

  it('counts remaining payload-bearing results without touching RAW', async () => {
    const query = jest.fn().mockResolvedValue([{ count: '7' }]);
    const repository = new ToolResultRepositoryDb({ query } as never);

    await expect(repository.countForReindex(true)).resolves.toBe(7);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('COUNT(*)');
    expect(sql).toContain('tool_result_chunks');
    expect(params).toEqual([true]);
  });
  it('binds stable result ID cursors for selecting and counting rebuild candidates', async()=>{
    const query=jest.fn().mockResolvedValue([]);
    const repository=new ToolResultRepositoryDb({query} as never);
    const cursor='00000000-0000-4000-8000-000000000001';
    await repository.findForReindex(25,false,cursor);
    expect(query.mock.calls[0][0]).toContain('result.result_id > $3::uuid');
    expect(query.mock.calls[0][0]).toContain('ORDER BY result.result_id ASC');
    expect(query.mock.calls[0][1]).toEqual([25,false,cursor]);
    await repository.countForReindex(false,cursor);
    expect(query.mock.calls[1][0]).toContain('result.result_id > $2::uuid');
    expect(query.mock.calls[1][1]).toEqual([false,cursor]);
  });

  it('replaces a result index in one atomic database statement',async()=>{
    const query=jest.fn().mockResolvedValue([]);
    const repository=new ToolResultRepositoryDb({query} as never);
    await repository.indexChunks('result-id',[
      {chunkIndex:0,chunkVersion:1,content:'first',embedding:null},
      {chunkIndex:1,chunkVersion:1,content:'second',embedding:[0.1,0.2]},
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT');
    expect(query.mock.calls[0][0]).toContain('NOT EXISTS');
    expect(query.mock.calls[0][1][0]).toBe('result-id');
    expect(JSON.parse(query.mock.calls[0][1][1])).toHaveLength(2);
  });

});
