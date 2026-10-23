import type { Request, Response } from 'express';

const repository = {
  create: jest.fn(),
  enforceRetention: jest.fn(),
  findById: jest.fn(),
  findPaginated: jest.fn(),
  search: jest.fn(),
  setPinned: jest.fn(),
  incrementUseCount: jest.fn(),
  getStats: jest.fn(),
};

jest.mock('../../src/services/toolResultHistoryRegistry.js', () => ({
  getToolResultRepository: jest.fn(() => repository),
  isToolResultHistoryAvailable: jest.fn(() => true),
}));

import {
  getToolResults,
  getToolResultById,
  getToolResultRaw,
  getToolResultRange,
  pinToolResult,
  searchToolResults,
  compareToolResults,
  getToolResultTimeline,
  getToolResultConversationTimeline,
  getToolResultLineage,
} from '../../src/controllers/toolResultController.js';

const makeReq = (overrides: Record<string, unknown> = {}) =>
  ({
    query: {},
    params: {},
    body: {},
    user: { username: 'admin', isAdmin: true },
    ...overrides,
  }) as unknown as Request;

const makeRes = () =>
  ({
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  }) as unknown as Response;

describe('toolResultController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repository.findPaginated.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 });
  });

  it('lists filtered history with bounded pagination', async () => {
    const res = makeRes();
    await getToolResults(
      makeReq({ query: { page: '2', limit: '25', server: 'dc', pinned: 'true' } }),
      res,
    );

    expect(repository.findPaginated).toHaveBeenCalledWith(2, 25, {
      server: 'dc',
      pinned: true,
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('returns immutable RAW and records later reuse', async () => {
    repository.findById.mockResolvedValue({
      resultId: 'result-id',
      raw: '{"content":[]}',
      payloadAvailable: true,
      rawBytes: 14,
    });
    const res = makeRes();

    await getToolResultRaw(makeReq({ params: { id: 'result-id' } }), res);

    expect(repository.incrementUseCount).toHaveBeenCalledWith('result-id');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json; charset=utf-8');
    expect(res.send).toHaveBeenCalledWith('{"content":[]}');
  });

  it('rejects RAW access for metadata-only results', async () => {
    repository.findById.mockResolvedValue({
      resultId: 'result-id',
      raw: null,
      payloadAvailable: false,
    });
    const res = makeRes();

    await getToolResultById(makeReq({ params: { id: 'result-id' } }), res);

    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.data).not.toHaveProperty('raw');
    expect(response.data).not.toHaveProperty('rawText');
  });

  it('validates byte ranges', async () => {
    repository.findById.mockResolvedValue({
      resultId: 'result-id',
      raw: 'hello',
      payloadAvailable: true,
    });
    const res = makeRes();

    await getToolResultRange(
      makeReq({ params: { id: 'result-id' }, query: { start: '4', end: '2' } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns valid RAW byte ranges as partial content', async () => {
    repository.findById.mockResolvedValue({
      resultId: 'result-id',
      raw: 'hello',
      payloadAvailable: true,
    });
    const res = makeRes();

    await getToolResultRange(
      makeReq({ params: { id: 'result-id' }, query: { start: '1', end: '4' } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(206);
    expect(res.setHeader).toHaveBeenCalledWith('Accept-Ranges', 'bytes');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Range', 'bytes 1-3/5');
    expect(res.send).toHaveBeenCalledWith(Buffer.from('ell'));
  });

  it('searches existing results without executing tools', async () => {
    repository.search.mockResolvedValue([]);
    const res = makeRes();

    await searchToolResults(makeReq({ query: { q: 'Xid 79', limit: '10' } }), res);

    expect(repository.search).toHaveBeenCalledWith('Xid 79', 10, {});
  });

  it('pins mutable state without updating RAW', async () => {
    repository.setPinned.mockResolvedValue({ resultId: 'result-id', pinned: true });
    const res = makeRes();

    await pinToolResult(makeReq({ params: { id: 'result-id' }, body: { pinned: true } }), res);

    expect(repository.setPinned).toHaveBeenCalledWith('result-id', true);
  });

  it('returns a bounded timeline for a session', async () => {
    repository.findPaginated.mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 });
    const res = makeRes();
    await getToolResultTimeline(makeReq({ params: { sessionId: 's-1' }, query: { limit: '50' } }), res);
    expect(repository.findPaginated).toHaveBeenCalledWith(1, 50, { sessionId: 's-1' });
  });

  it('returns a bounded timeline for a conversation', async () => {
    repository.findPaginated.mockResolvedValue({ data: [], total: 0, page: 1, limit: 40, totalPages: 0 });
    const res = makeRes();
    await getToolResultConversationTimeline(makeReq({ params: { conversationId: 'c-1' }, query: { limit: '40' } }), res);
    expect(repository.findPaginated).toHaveBeenCalledWith(1, 40, { conversationId: 'c-1' });
  });

  it('returns bounded parent and child lineage without RAW', async () => {
    repository.findById
      .mockResolvedValueOnce({ resultId: 'child', parentResultId: 'parent', raw: 'hidden' })
      .mockResolvedValueOnce({ resultId: 'parent', raw: 'hidden' });
    repository.findPaginated.mockResolvedValue({ data: [{ resultId: 'grandchild', raw: 'hidden' }], total: 1, page: 1, limit: 50, totalPages: 1 });
    const res = makeRes();
    await getToolResultLineage(makeReq({ params: { id: 'child' } }), res);
    expect(repository.findPaginated).toHaveBeenCalledWith(1, 50, { parentResultId: 'child' });
    const data = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(data.ancestors[0]).toEqual(expect.objectContaining({ resultId: 'parent' }));
    expect(data.ancestors[0]).not.toHaveProperty('raw');
    expect(data.children[0]).not.toHaveProperty('raw');
  });

  it('compares exactly two result records without exposing RAW', async () => {
    repository.findById
      .mockResolvedValueOnce({ resultId: 'a', rawSha256: 'same', rawBytes: 10, payloadAvailable: true })
      .mockResolvedValueOnce({ resultId: 'b', rawSha256: 'same', rawBytes: 10, payloadAvailable: true });
    const res = makeRes();
    await compareToolResults(makeReq({ body: { resultIds: ['a', 'b'] } }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: expect.objectContaining({ sameRaw: true }) }));
    expect((res.json as jest.Mock).mock.calls[0][0].data.results[0]).not.toHaveProperty('raw');
  });
});
