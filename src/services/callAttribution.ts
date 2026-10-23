import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AttributionIdentity, AttributionClientClaims } from './attributionContextService.js';

export interface CallAttribution {
  callId: string;
  contextId: string | null;
  taskId: string | null;
  traceId: string | null;
  modelSegmentId: string | null;
  identity: AttributionIdentity;
  branchId?: string | null;
  clientClaims?: AttributionClientClaims;
}

const storage = new AsyncLocalStorage<CallAttribution>();
export const getCallAttribution = (): CallAttribution | undefined => storage.getStore();
export const runWithCallAttribution = <T>(
  context: Omit<CallAttribution, 'callId'> | null,
  callback: () => T,
): T => storage.run({
  callId: randomUUID(), contextId: context?.contextId ?? null,
  taskId: context?.taskId ?? null, traceId: context?.traceId ?? null,
  modelSegmentId: context?.modelSegmentId ?? null,
  branchId: context?.branchId ?? null, clientClaims: context?.clientClaims ?? {},
  identity: context?.identity ?? { modelId: null, source: 'unknown', verified: false },
}, callback);
