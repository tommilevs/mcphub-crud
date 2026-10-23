import { AttributionContextService } from '../../src/services/attributionContextService.js';
import { withAttributionHandshake } from '../../src/services/attributionHandshake.js';
import { getCallAttribution } from '../../src/services/callAttribution.js';

test('records explicit agent reactions only with resolved context and strips them upstream', async () => {
  const records = new Map<string, any>();
  const recordLoopGuardReaction = jest.fn(async () => {});
  const service = new AttributionContextService({ insert: async r => { records.set(r.keyDigest, r); },
    findByDigest: async d => records.get(d) ?? null, recordLoopGuardReaction });
  const issued = await service.start('alice');
  const reaction = { result_id: 'af3e4f22-cd76-4b99-8cf7-52db210e54de', action: 'changed_strategy' };
  const request = { params: { name: 'call_tool', arguments: { hub_context: { trace_key: issued.traceKey, loopguard_reaction: reaction } } } };
  const handler = jest.fn(async (cleaned) => { expect(cleaned.params.arguments.hub_context).toBeUndefined(); return { content: [] }; });
  await withAttributionHandshake(request, 'alice', service, handler);
  expect(recordLoopGuardReaction).toHaveBeenCalledWith(expect.objectContaining({ branchId: issued.branchId }), expect.any(String), reaction);
  recordLoopGuardReaction.mockClear();
  for (const invalid of [{ result_id: 'bad', action: 'accepted' }, { ...reaction, action: 'task_success' }]) {
    await service.recordLoopGuardReaction(issued, 'test-call', invalid);
  }
  expect(recordLoopGuardReaction).not.toHaveBeenCalled();
  await withAttributionHandshake(request, 'bob', service, handler);
  expect(recordLoopGuardReaction).not.toHaveBeenCalled();
  recordLoopGuardReaction.mockRejectedValue(new Error('offline'));
  await withAttributionHandshake(request, 'alice', service, handler);
  expect(handler).toHaveBeenCalledTimes(3);
});

test('handshake preserves nested content and continues the same context without leaking keys downstream', async () => {
  const records = new Map<string, any>();
  const service = new AttributionContextService({
    insert: async (r) => { records.set(r.keyDigest, r); },
    findByDigest: async (d) => records.get(d) ?? null,
  });
  const handler = jest.fn(async () => ({ content: [{ type: 'text', text: 'original' }], _meta: { existing: true } }));
  const request = { params: { name: 'call_tool', arguments: { toolName: 'demo', hub_context: { action: 'start', model_claim: 'exact-model' } } } };
  const result = await withAttributionHandshake(request, 'alice', service, handler);
  const context = result._meta['dev.mcphub/context'];
  expect(context.model_identity.verified).toBe(false);
  expect(result.content).toEqual([{ type: 'text', text: 'original' }]);
  expect(result._meta.existing).toBe(true);
  expect(handler.mock.calls[0][0].params.arguments.hub_context).toBeUndefined();
  const next = await withAttributionHandshake({ params: { name: 'search_tools', arguments: { query: 'demo', hub_context: { trace_key: context.trace_key } } } }, 'alice', service, handler);
  expect(next._meta['dev.mcphub/context'].context_id).toBe(context.context_id);
  expect(next._meta['dev.mcphub/context'].trace_key).toBeUndefined();
});

test('database failure does not replay a side-effecting tool', async () => {
  const service = new AttributionContextService({
    insert: async () => { throw new Error('database unavailable'); },
    findByDigest: async () => null,
  });
  let executions = 0;
  const result = await withAttributionHandshake({ params: { name: 'call_tool', arguments: {
    toolName: 'change', hub_context: { action: 'start' },
  } } }, 'alice', service, async (request) => {
    executions += 1;
    expect(request.params.arguments.hub_context).toBeUndefined();
    return { content: [{ type: 'text', text: 'changed' }] };
  });
  expect(executions).toBe(1);
  expect(result.content[0].text).toBe('changed');
});

test('a foreign key degrades to unknown and preserves execution', async () => {
  const records = new Map<string, any>();
  const service = new AttributionContextService({
    insert: async (record) => { records.set(record.keyDigest, record); },
    findByDigest: async (digest) => records.get(digest) ?? null,
  });
  const issued = await service.start('alice', { modelClaim: 'alice-model' });
  const result = await withAttributionHandshake({ params: { name: 'describe_tool', arguments: {
    toolName: 'demo', hub_context: { trace_key: issued.traceKey },
  } } }, 'bob', service, async () => ({ content: [] }));
  expect(result._meta).toBeUndefined();
});

test('namespaced metadata continues a context and is removed before upstream invocation', async () => {
  const records = new Map<string, any>();
  const service = new AttributionContextService({
    insert: async (r) => { records.set(r.keyDigest, r); },
    findByDigest: async (d) => records.get(d) ?? null,
  });
  const context = await service.start('alice', { modelClaim: 'model-a' });
  const result = await withAttributionHandshake({ params: { name: 'call_tool', arguments: { toolName: 'demo' },
    _meta: { 'dev.mcphub/attribution': { trace_key: context.traceKey, verified: true }, other: 'preserved' },
  } }, 'alice', service, async (request) => {
    expect(request.params._meta).toEqual({ other: 'preserved' });
    expect(getCallAttribution()?.identity.verified).toBe(false);
    return { content: [] };
  });
  expect(result._meta['dev.mcphub/context'].context_id).toBe(context.contextId);
});

test('conflicting input keys yield unknown attribution instead of selecting either owner', async () => {
  const service = new AttributionContextService({ insert: async () => {}, findByDigest: async () => null });
  await withAttributionHandshake({ params: { name: 'call_tool', arguments: {
    toolName: 'demo', hub_context: { trace_key: 'first' },
  }, _meta: { 'dev.mcphub/attribution': { trace_key: 'second' } } } }, 'alice', service, async () => {
    expect(getCallAttribution()?.identity.source).toBe('unknown');
    expect(getCallAttribution()?.conflictReason).toBe('conflicting_trace_keys');
    return { content: [] };
  });
});

test('a discovery telemetry failure leaves the original search response intact', async () => {
  let attempted = false;
  const service = new AttributionContextService({ insert: async () => {}, findByDigest: async () => null,
    recordDiscovery: async () => { attempted = true; throw new Error('offline'); },
  });
  const content = [{ type: 'text', text: JSON.stringify({ tools: [{ name: 'demo-tool' }] }) }];
  const result = await withAttributionHandshake({ params: { name: 'search_tools', arguments: { query: 'private objective', hub_context: { action: 'start' } } } },
    'alice', service, async () => ({ content }));
  expect(attempted).toBe(true);
  expect(result.content).toEqual(content);
});

test('repeat intent is call-local during parallel requests and is stripped upstream', async () => {
  const records = new Map<string, any>();
  const service = new AttributionContextService({ insert: async (r) => { records.set(r.keyDigest, r); },
    findByDigest: async (d) => records.get(d) ?? null });
  const context = await service.start('alice');
  const invoke = (intent?: string) => withAttributionHandshake({ params: { name: 'call_tool', arguments: {
    toolName: 'demo', hub_context: { trace_key: context.traceKey, ...(intent ? { repeat_intent: intent } : {}) },
  } } }, 'alice', service, async (cleaned) => {
    await new Promise((resolve) => setImmediate(resolve));
    expect(cleaned.params.arguments.hub_context).toBeUndefined();
    return { intent: getCallAttribution()?.repeatIntent };
  });
  const [intentional, ordinary] = await Promise.all([invoke('retry'), invoke()]);
  expect(intentional.intent).toBe('retry');
  expect(ordinary.intent).toBeUndefined();
});
