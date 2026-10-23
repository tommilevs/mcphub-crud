import type { Request, Response } from 'express';
const mockQuery = jest.fn();
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => ({ query: mockQuery }) }));
import { saveTaskReview } from '../../src/controllers/taskReviewController.js';
const taskId = 'af3e4f22-cd76-4b99-8cf7-52db210e54de';
const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });
test('saves an explicit human task review without inferring success or consent', async () => {
  mockQuery.mockResolvedValue([{ task_id: taskId, revision: 1, outcome: 'partial', training_consent: false }]);
  const response = res();
  await saveTaskReview({ user: { isAdmin: true, username: 'admin' }, params: { taskId }, body: { outcome: 'partial', trainingConsent: false, revision: 0 } } as unknown as Request, response as unknown as Response);
  expect(mockQuery.mock.calls[0][1]).toEqual([taskId, 1, 'partial', false, 'admin', 0]);
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
});
test('rejects unreviewed input and stale writes', async () => {
  const invalid = res();
  await saveTaskReview({ user: { isAdmin: true }, params: { taskId }, body: { outcome: 'success' } } as unknown as Request, invalid as unknown as Response);
  expect(invalid.status).toHaveBeenCalledWith(400);
  mockQuery.mockResolvedValue([]);
  const stale = res();
  await saveTaskReview({ user: { isAdmin: true, username: 'admin' }, params: { taskId }, body: { outcome: 'success', trainingConsent: false, revision: 1 } } as unknown as Request, stale as unknown as Response);
  expect(stale.status).toHaveBeenCalledWith(409);
});
