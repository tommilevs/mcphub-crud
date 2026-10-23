import type { Request, Response } from 'express';
const mockQuery = jest.fn();
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => ({ query: mockQuery }) }));
import { submitLoopGuardFeedback, getLoopGuardSummary } from '../../src/controllers/loopGuardFeedbackController.js';
const resultId = 'af3e4f22-cd76-4b99-8cf7-52db210e54de';
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });

beforeEach(() => mockQuery.mockReset());

test('summarizes latest explicit verdicts with a reviewed-only denominator', async () => {
  const summary = { advice: 10, reviewed: 4, helpful: 2, falsePositive: 1, ignored: 1, unreviewed: 6,
    assessed: 3, reportedFalsePositiveRate: 1 / 3 };
  mockQuery.mockResolvedValue([{ summary }]);
  const res = response();
  await getLoopGuardSummary({ user: { isAdmin: true }, query: { days: '7' } } as unknown as Request, res as unknown as Response);
  expect(mockQuery.mock.calls[0][1]).toEqual([7]);
  expect(mockQuery.mock.calls[0][0]).toContain('loop_guard_feedback');
  expect(mockQuery.mock.calls[0][0]).not.toContain('raw_result');
  expect(res.json).toHaveBeenCalledWith({ success: true, data: summary, meta: { days: 7 } });
});

test('summary rejects non-admins, invalid periods and degrades on unavailable database', async () => {
  for (const days of ['0', '3651', 'NaN', '2.5']) {
    const res = response();
    await getLoopGuardSummary({ user: { isAdmin: true }, query: { days } } as unknown as Request, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(400);
  }
  const denied = response();
  await getLoopGuardSummary({ user: { isAdmin: false }, query: {} } as unknown as Request, denied as unknown as Response);
  expect(denied.status).toHaveBeenCalledWith(403);
  expect(mockQuery).not.toHaveBeenCalled();
  mockQuery.mockRejectedValue(new Error('offline'));
  const unavailable = response();
  await getLoopGuardSummary({ user: { isAdmin: true }, query: {} } as unknown as Request, unavailable as unknown as Response);
  expect(unavailable.status).toHaveBeenCalledWith(503);
});
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
