import { AttributionContextService } from '../../src/services/attributionContextService.js';

describe('attribution contexts', () => {
  it('rotates a model segment while preserving task and trace and revoking the old key', async () => {
    const records = new Map<string, any>();
    const service = new AttributionContextService({
      insert: async (r) => { records.set(r.keyDigest, r); },
      findByDigest: async (d) => records.get(d) ?? null,
      rotate: async (old, next) => {
        if (records.get(old)?.revokedAt) return false;
        records.get(old).revokedAt = next.createdAt;
        records.set(next.keyDigest, next);
        return true;
      },
    });
    const first = await service.start('alice', { modelClaim: 'one' });
    expect(await service.rotate('bob', first.traceKey, 'two')).toBeNull();
    const next = await service.rotate('alice', first.traceKey, 'two');
    expect(next?.traceId).toBe(first.traceId);
    expect(next?.taskId).toBe(first.taskId);
    expect(next?.modelSegmentId).not.toBe(first.modelSegmentId);
    expect(next?.identity.modelId).toBe('two');
    expect(await service.resolve('alice', first.traceKey)).toBeNull();
    expect(await service.resolve('alice', next!.traceKey)).not.toBeNull();
  });
  it('issues independent contexts and stores only a key digest', async () => {
    const records = new Map<string, any>();
    const service = new AttributionContextService({
      insert: async (record) => { records.set(record.keyDigest, record); },
      findByDigest: async (digest) => records.get(digest) ?? null,
    });
    const first = await service.start('alice', { modelClaim: 'model-a' });
    const second = await service.start('alice', { modelClaim: 'model-a' });
    expect(first.traceKey).not.toBe(second.traceKey);
    expect(first.taskId).not.toBe(second.taskId);
    expect(first.traceKey).toMatch(/^k_[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify([...records.values()])).not.toContain(first.traceKey);
    const resolved = await service.resolve('alice', first.traceKey);
    expect(resolved?.identity).toEqual({ modelId: 'model-a', source: 'self_reported', verified: false });
    expect(await service.resolve('bob', first.traceKey)).toBeNull();
  });

  it('keeps unknown models unknown and rejects expired or revoked keys', async () => {
    let saved: any;
    let now = new Date('2026-10-23T00:00:00Z');
    const service = new AttributionContextService({
      insert: async (record) => { saved = record; },
      findByDigest: async () => saved,
    }, () => now, 1000);
    const context = await service.start('alice');
    expect(context.identity).toEqual({ modelId: null, source: 'unknown', verified: false });
    now = new Date(now.getTime() + 1000);
    expect(await service.resolve('alice', context.traceKey)).toBeNull();
    now = new Date('2026-10-23T00:00:00Z');
    saved.revokedAt = now;
    expect(await service.resolve('alice', context.traceKey)).toBeNull();
  });
});
