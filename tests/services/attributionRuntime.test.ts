const mockConfig = jest.fn();
jest.mock('../../src/utils/smartRouting.js', () => ({ getSmartRoutingConfig: () => mockConfig() }));
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => { throw new Error('offline'); } }));
import { runWithAttribution } from '../../src/services/attributionRuntime.js';
import { RequestContextService } from '../../src/services/requestContextService.js';
import { getCallAttribution } from '../../src/services/callAttribution.js';

const request = () => ({ params: { name: 'call_tool', arguments: {
  toolName: 'write', hub_context: { action: 'start' },
}, _meta: { 'dev.mcphub/attribution': { trace_key: 'private-key' }, other: 'preserved' } } });

test('configuration outage preserves exactly one execution and strips hub-owned metadata', async () => {
  mockConfig.mockRejectedValue(new Error('offline'));
  let executions = 0;
  const result = await runWithAttribution(request(), async (cleaned) => {
    executions++;
    expect(cleaned.params.arguments.hub_context).toBeUndefined();
    expect(cleaned.params._meta).toEqual({ other: 'preserved' });
    expect(getCallAttribution()?.identity.source).toBe('unknown');
    return { content: [] };
  });
  expect(executions).toBe(1);
  expect(result).toEqual({ content: [] });
});

test('database outage strips correlation metadata without replaying the handler', async () => {
  mockConfig.mockResolvedValue({ attributionMode: 'compatible' });
  await RequestContextService.getInstance().runWithCustomRequestContext({ headers: {}, username: 'alice' }, async () => {
    let executions = 0;
    await expect(runWithAttribution(request(), async (cleaned) => {
      executions++;
      expect(cleaned.params.arguments.hub_context).toBeUndefined();
      throw new Error('tool failed');
    })).rejects.toThrow('tool failed');
    expect(executions).toBe(1);
  });
});
