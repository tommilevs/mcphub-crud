import type { Request, Response } from 'express';
const mockQuery = jest.fn();
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => ({ query: mockQuery }) }));
import { getAttributionEvents } from '../../src/controllers/attributionController.js';

const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });
test('requires admin and rejects invalid trace or unbounded limits', async () => {
  const res = response();
  await getAttributionEvents({ user: { isAdmin: false }, params: {}, query: {} } as unknown as Request, res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(403);
  const invalid = response();
  await getAttributionEvents({ user: { isAdmin: true }, params: { traceId: 'bad' }, query: {} } as unknown as Request, invalid as unknown as Response);
  expect(invalid.status).toHaveBeenCalledWith(400);
});

test('returns ordered event metadata without querying keys or principals', async () => {
  mockQuery.mockResolvedValue([{ event_type: 'context_started' }]);
  const traceId = 'af3e4f22-cd76-4b99-8cf7-52db210e54de';
  const res = response();
  await getAttributionEvents({ user: { isAdmin: true }, params: { traceId }, query: { limit: '25' } } as unknown as Request, res as unknown as Response);
  const [sql, parameters] = mockQuery.mock.calls[0];
  expect(sql).toContain('ORDER BY occurred_at ASC, event_id ASC');
  expect(sql).not.toMatch(/key_digest|principal|SELECT \*/);
  expect(parameters).toEqual([traceId, 26]);
  expect(res.json).toHaveBeenCalledWith({ success: true, data: [{ event_type: 'context_started' }], meta: { hasMore: false, limit: 25 } });
});
