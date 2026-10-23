const query = jest.fn();
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => ({ query }) }));
jest.mock('../../src/utils/smartRouting.js', () => ({ getSmartRoutingConfig: async () => ({
  loopGuardEnabled: true, loopGuardRepetitions: 4,
}) }));
import { observeLoopGuard } from '../../src/services/loopGuardCoordinator.js';
import type { ToolResultRecord } from '../../src/types/toolResult.js';

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
