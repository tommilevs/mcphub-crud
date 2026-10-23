import { AttributionContextService } from '../../src/services/attributionContextService.js';
import { withAttributionHandshake } from '../../src/services/attributionHandshake.js';

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
