import { createHash, randomBytes, randomUUID } from 'node:crypto';

export interface AttributionIdentity {
  modelId: string | null;
  source: 'unknown' | 'self_reported';
  verified: false;
}

export interface AttributionClientClaims {
  clientNameClaim?: string;
  clientInstanceHint?: string;
  agentRunHint?: string;
  taskHint?: string;
}

export interface AttributionContextRecord {
  contextId: string;
  taskId: string;
  traceId: string;
  modelSegmentId: string;
  branchId: string;
  clientClaims: AttributionClientClaims;
  principal: string;
  keyDigest: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  identity: AttributionIdentity;
}

export interface AttributionContextStore {
  insert(record: AttributionContextRecord, event?: 'context_started' | 'branch_forked', parentContextId?: string): Promise<void>;
  findByDigest(digest: string): Promise<AttributionContextRecord | null>;
  rotate?(oldDigest: string, next: AttributionContextRecord): Promise<boolean>;
}

const digestKey = (key: string): string => createHash('sha256').update(key).digest('hex');

/** Correlation only: callers must supply their authenticated, tenant-scoped principal. */
export class AttributionContextService {
  constructor(
    private readonly store: AttributionContextStore,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = 7 * 24 * 60 * 60 * 1000,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('Invalid context TTL');
  }

  async start(principal: string, claims: AttributionClientClaims & { modelClaim?: string | null } = {}) {
    if (!principal) throw new Error('Authenticated principal is required');
    const modelId = claims.modelClaim?.trim() || null;
    if (modelId && (modelId.length > 255 || /[\u0000-\u001f]/.test(modelId))) {
      throw new Error('Invalid model claim');
    }
    const clientClaims: AttributionClientClaims = {};
    for (const name of ['clientNameClaim', 'clientInstanceHint', 'agentRunHint', 'taskHint'] as const) {
      const value = claims[name];
      if (value == null) continue;
      if (typeof value !== 'string' || value.length > 255 || /[\u0000-\u001f]/.test(value)) {
        throw new Error('Invalid client claim');
      }
      if (value.trim()) clientClaims[name] = value.trim();
    }
    const traceKey = `k_${randomBytes(24).toString('base64url')}`;
    const createdAt = this.now();
    const record: AttributionContextRecord = {
      contextId: randomUUID(), taskId: randomUUID(), traceId: randomUUID(),
      modelSegmentId: randomUUID(), principal, keyDigest: digestKey(traceKey),
      branchId: randomUUID(), clientClaims,
      createdAt, expiresAt: new Date(createdAt.getTime() + this.ttlMs),
      identity: { modelId, source: modelId ? 'self_reported' : 'unknown', verified: false },
    };
    await this.store.insert(record);
    const { keyDigest: _digest, principal: _principal, ...context } = record;
    return { ...context, traceKey };
  }

  async fork(principal: string, traceKey: string, modelClaim?: string | null) {
    const previous = await this.resolve(principal, traceKey);
    if (!previous) return null;
    const modelId = modelClaim?.trim() || null;
    if (modelId && (modelId.length > 255 || /[\u0000-\u001f]/.test(modelId))) {
      throw new Error('Invalid model claim');
    }
    const nextKey = `k_${randomBytes(24).toString('base64url')}`;
    const createdAt = this.now();
    const next: AttributionContextRecord = {
      ...previous, contextId: randomUUID(), branchId: randomUUID(), modelSegmentId: randomUUID(),
      clientClaims: {}, keyDigest: digestKey(nextKey), createdAt,
      expiresAt: new Date(createdAt.getTime() + this.ttlMs), revokedAt: undefined,
      identity: { modelId, source: modelId ? 'self_reported' : 'unknown', verified: false },
    };
    await this.store.insert(next, 'branch_forked', previous.contextId);
    const { keyDigest: _digest, principal: _principal, ...context } = next;
    return { ...context, traceKey: nextKey };
  }

  async rotate(principal: string, traceKey: string, modelClaim?: string | null) {
    const previous = await this.resolve(principal, traceKey);
    if (!previous || !this.store.rotate) return null;
    const modelId = modelClaim?.trim() || null;
    if (modelId && (modelId.length > 255 || /[\u0000-\u001f]/.test(modelId))) {
      throw new Error('Invalid model claim');
    }
    const nextKey = `k_${randomBytes(24).toString('base64url')}`;
    const createdAt = this.now();
    const next: AttributionContextRecord = {
      ...previous, contextId: randomUUID(), modelSegmentId: randomUUID(),
      keyDigest: digestKey(nextKey), createdAt,
      expiresAt: new Date(createdAt.getTime() + this.ttlMs), revokedAt: undefined,
      identity: { modelId, source: modelId ? 'self_reported' : 'unknown', verified: false },
    };
    if (!await this.store.rotate(previous.keyDigest, next)) return null;
    const { keyDigest: _digest, principal: _principal, ...context } = next;
    return { ...context, traceKey: nextKey };
  }

  async resolve(principal: string, traceKey: string): Promise<AttributionContextRecord | null> {
    if (!principal || !/^k_[A-Za-z0-9_-]{32}$/.test(traceKey)) return null;
    const record = await this.store.findByDigest(digestKey(traceKey));
    if (!record || record.principal !== principal || record.revokedAt ||
      record.expiresAt.getTime() <= this.now().getTime()) return null;
    return record;
  }
}
