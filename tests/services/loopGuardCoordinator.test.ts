const query = jest.fn();
const config = { loopGuardEnabled: true, loopGuardRepetitions: 4, loopGuardToolBudgets: {} as Record<string, number> };
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => ({ query }) }));
jest.mock('../../src/utils/smartRouting.js', () => ({ getSmartRoutingConfig: async () => config }));
import { observeLoopGuard } from '../../src/services/loopGuardCoordinator.js';
import type { ToolResultRecord } from '../../src/types/toolResult.js';

beforeEach(() => { query.mockReset(); config.loopGuardToolBudgets = {}; });

test('honors the larger tool budget in an alternating cycle regardless of current tool', async () => {
  config.loopGuardToolBudgets = { 'demo/b': 5 };
  const record = { resultId: 'current', timestamp: new Date(10000), server: 'demo', tool: 'a',
    status: 'error', arguments: '{}', rawSha256: 'digest',
    attribution: { traceId: 'trace', branchId: 'branch' } } as ToolResultRecord;
  const rows = Array.from({ length: 9 }, (_, index) => ({ result_id: `r${index}`, timestamp: new Date(9000 - index * 1000),
    server: 'demo', tool: index % 2 ? 'a' : 'b', status: 'error', arguments: '{}', raw_sha256: 'digest' }));
  query.mockResolvedValueOnce(rows.slice(0, 7));
  expect(await observeLoopGuard(record)).toBeNull();
  query.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
  expect((await observeLoopGuard(record))?.resultIds).toHaveLength(10);
  expect(query.mock.calls[0][1][6]).toBe(9);
});

test('fetches enough isolated history to honor the configured repetition budget', async () => {
  const record = { resultId: 'current', timestamp: new Date(4000), server: 'demo', tool: 'inspect',
    status: 'error', arguments: '{}', rawSha256: 'digest', username: 'owner', keyId: 'key',
    attribution: { traceId: 'trace', branchId: 'branch' } } as ToolResultRecord;
  const rows = [3, 2, 1].map((index) => ({ result_id: `r${index}`, timestamp: new Date(index * 1000),
    server: 'demo', tool: 'inspect', status: 'error', arguments: '{}', raw_sha256: 'digest' }));
  query.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
  expect((await observeLoopGuard(record))?.resultIds).toHaveLength(4);
  expect(query.mock.calls[0][0]).toContain('LIMIT $7');
  expect(query.mock.calls[0][1]).toEqual(['owner', 'key', 'trace', 'branch', record.timestamp, 'current', 7]);
  expect(query.mock.calls[1][0]).toContain('UPDATE tool_result_state');
});
