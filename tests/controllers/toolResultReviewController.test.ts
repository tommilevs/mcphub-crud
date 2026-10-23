import type { Request, Response } from 'express';
const query = jest.fn();
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => ({ query }) }));
import { saveToolResultReview } from '../../src/controllers/toolResultReviewController.js';
const id = 'af3e4f22-cd76-4b99-8cf7-52db210e54de';
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const request = (body = {}) => ({ user: { isAdmin: true, username: 'reviewer' }, params: { id },
  body: { quality: 'correct', privacy: 'approved', revision: 0, rawSha256: 'a'.repeat(64), ...body } }) as unknown as Request;
beforeEach(() => query.mockReset());

test.each([{ quality: 'success' }, { privacy: true }, { revision: -1 }, { revision: 0.5 }, { rawSha256: 'missing' }])('rejects invalid review %s before database access', async body => {
  const res = response();
  await saveToolResultReview(request(body),res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(query).not.toHaveBeenCalled();
});
test('rejects non-admins, reports stale review and degrades on database failure', async () => {
  const denied = response();
  await saveToolResultReview({ ...request(), user: { isAdmin: false } } as Request,denied as unknown as Response);
  expect(denied.status).toHaveBeenCalledWith(403);
  expect(query).not.toHaveBeenCalled();
  query.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('offline'));
  const stale = response(), offline = response();
  await saveToolResultReview(request(),stale as unknown as Response);
  expect(stale.status).toHaveBeenCalledWith(409);
  await saveToolResultReview(request(),offline as unknown as Response);
  expect(offline.status).toHaveBeenCalledWith(503);
});
