import { getCallAttribution, runWithCallAttribution } from '../../src/services/callAttribution.js';
import { ToolResultHistoryService } from '../../src/services/toolResultHistoryService.js';

test('parallel calls have unique isolated snapshots and do not persist keys', async () => {
  const invoke = (id: string) => runWithCallAttribution({ contextId: id, taskId: id,
    traceId: id, modelSegmentId: id,
    identity: { modelId: id, source: 'self_reported', verified: false },
  }, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return getCallAttribution()!;
  });
  const [a, b] = await Promise.all([invoke('a'), invoke('b')]);
  expect(a.contextId).toBe('a');
  expect(b.contextId).toBe('b');
  expect(a.callId).not.toBe(b.callId);
  expect(getCallAttribution()).toBeUndefined();
});

test('history stores the call snapshot beside the unchanged RAW', async () => {
  const history = new ToolResultHistoryService({
    create: async (record: any) => record,
    enforceRetention: async () => 0,
  } as any);
  const raw = { content: [{ type: 'text', text: 'exact evidence' }] };
  const result = await runWithCallAttribution(null, () => history.capture({
    server: 'demo', tool: 'inspect', durationMs: 1, status: 'success', result: raw,
  }));
  expect(result?.attribution?.callId).toMatch(/^[0-9a-f-]{36}$/);
  expect(result?.attribution?.identity.source).toBe('unknown');
  expect(result?.raw).toBe(JSON.stringify(raw));
});
