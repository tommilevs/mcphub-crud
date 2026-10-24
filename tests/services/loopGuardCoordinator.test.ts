const query = jest.fn();
const getAdvice=jest.fn();
jest.mock('../../src/services/experienceAdvice.js',()=>({getExperienceAdvice:(...args:any[])=>getAdvice(...args)}));
const config = { loopGuardEnabled: true, loopGuardRepetitions: 4, loopGuardToolBudgets: {} as Record<string, number>,loopGuardUnchangedTools:[] as string[] };
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => ({ query }) }));
jest.mock('../../src/utils/smartRouting.js', () => ({ getSmartRoutingConfig: async () => config }));
jest.mock('../../src/utils/systemConfigCache.js',()=>({getCachedSystemConfig:()=>({smartRouting:config})}));
import { observeLoopGuard } from '../../src/services/loopGuardCoordinator.js';
import type { ToolResultRecord } from '../../src/types/toolResult.js';

beforeEach(() => { query.mockReset();getAdvice.mockReset().mockResolvedValue([]); config.loopGuardToolBudgets = {};config.loopGuardUnchangedTools=[]; });
test('observes successful responses only for explicitly selected tools and preserves success',async()=>{
 const record={resultId:'current',timestamp:new Date(5000),server:'demo',tool:'inspect',status:'success',arguments:'{}',rawSha256:'digest',attribution:{traceId:'trace',branchId:'branch'}} as ToolResultRecord;
 expect(await observeLoopGuard(record)).toBeNull();expect(query).not.toHaveBeenCalled();
 config.loopGuardUnchangedTools=['demo/inspect'];
 query.mockResolvedValueOnce([4,3,2,1].map(index=>({result_id:`r${index}`,timestamp:new Date(index*1000),server:'demo',tool:'inspect',status:'success',arguments:'{}',raw_sha256:'digest'}))).mockResolvedValueOnce([]);
 expect((await observeLoopGuard(record))?.trigger).toBe('repeated_unchanged_response');
 expect(record.status).toBe('success');expect(query.mock.calls[1][0]).toContain('tool_result_state');
});

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
  getAdvice.mockResolvedValueOnce([{experienceId:'experience',revision:1,evidenceResultIds:['evidence'],confidence:'supported',title:'Strategy',summary:'Consider another diagnostic'}]);
  const record = { resultId: 'current', timestamp: new Date(4000), server: 'demo', tool: 'inspect',
    status: 'error', arguments: '{}', rawSha256: 'digest', username: 'owner', keyId: 'key',
    attribution: { traceId: 'trace', branchId: 'branch' } } as ToolResultRecord;
  const rows = [3, 2, 1].map((index) => ({ result_id: `r${index}`, timestamp: new Date(index * 1000),
    server: 'demo', tool: 'inspect', status: 'error', arguments: '{}', raw_sha256: 'digest' }));
  query.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
  const advice=await observeLoopGuard(record);
  expect(advice?.resultIds).toHaveLength(4);
  expect(advice?.experiences?.[0].summary).toBe('Consider another diagnostic');
  expect(query.mock.calls[0][0]).toContain('LIMIT $7');
  expect(query.mock.calls[0][1]).toEqual(['owner', 'key', 'trace', 'branch', record.timestamp, 'current', 7]);
  expect(query.mock.calls[1][0]).toContain('UPDATE tool_result_state');
  expect(JSON.parse(query.mock.calls[1][1][1]).experiences).toEqual([{experienceId:'experience',revision:1,evidenceResultIds:['evidence'],confidence:'supported'}]);
});
