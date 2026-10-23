import type { Request, Response } from 'express';
const mockQuery = jest.fn();
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => ({ query: mockQuery }) }));
import { submitLoopGuardFeedback } from '../../src/controllers/loopGuardFeedbackController.js';
const resultId = 'af3e4f22-cd76-4b99-8cf7-52db210e54de';
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });
test('stores an explicit false-positive observation without modifying RAW or permissions', async () => {
  mockQuery.mockResolvedValue([{ loop_guard_feedback: { verdict: 'false_positive' } }]);
  const res = response();
  await submitLoopGuardFeedback({ user: { isAdmin: true, username: 'reviewer' }, params: { id: resultId }, body: { verdict: 'false_positive' } } as unknown as Request, res as unknown as Response);
  expect(mockQuery.mock.calls[0][0]).toContain('INSERT INTO tool_result_loop_feedback');
  expect(mockQuery.mock.calls[0][0]).not.toContain('UPDATE tool_results');
  expect(mockQuery.mock.calls[0][1].slice(1)).toEqual([resultId, 'false_positive', 'reviewer']);
  expect(res.json).toHaveBeenCalledWith({ success: true, data: { verdict: 'false_positive' } });
});
test('rejects automatic outcome labels and missing advice', async () => {
  const res = response();
  await submitLoopGuardFeedback({ user: { isAdmin: true, username: 'reviewer' }, params: { id: resultId }, body: { verdict: 'task_success' } } as unknown as Request, res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(400);
  mockQuery.mockResolvedValue([]);
  const missing = response();
  await submitLoopGuardFeedback({ user: { isAdmin: true, username: 'reviewer' }, params: { id: resultId }, body: { verdict: 'helpful' } } as unknown as Request, missing as unknown as Response);
  expect(missing.status).toHaveBeenCalledWith(404);
});
