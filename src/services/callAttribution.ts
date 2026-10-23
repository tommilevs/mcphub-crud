import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AttributionIdentity, AttributionClientClaims } from './attributionContextService.js';

export interface CallAttribution {
  callId: string;
  contextId: string | null;
  taskId: string | null;
  traceId: string | null;
  modelSegmentId: string | null;
  identity: AttributionIdentity | { modelId: string; source: 'gateway_observed'; verified: true };
  provenance?: { adapterId: string; modelId: string; responseId: string; toolCallId: string;
    invocationSha256: string; claimedModelId?: string | null; causalCorrelationVerified: true };
  branchId?: string | null;
  clientClaims?: AttributionClientClaims;
  conflictReason?: string;
  repeatIntent?: 'poll' | 'pagination' | 'wait' | 'retry';
  invokedToolName?: string;
}

const storage = new AsyncLocalStorage<CallAttribution>();
export const withCallAttributionOverride = <T>(patch: Partial<CallAttribution>, callback: () => T): T => {
  const current = storage.getStore();
  return current ? storage.run({ ...current, ...patch }, callback) : callback();
};
export const getCallAttribution = (): CallAttribution | undefined => storage.getStore();
export const runWithCallAttribution = <T>(
  context: Omit<CallAttribution, 'callId'> | null,
  callback: () => T,
): T => storage.run({
  callId: randomUUID(), contextId: context?.contextId ?? null,
  taskId: context?.taskId ?? null, traceId: context?.traceId ?? null,
  modelSegmentId: context?.modelSegmentId ?? null,
  branchId: context?.branchId ?? null, clientClaims: context?.clientClaims ?? {},
  ...(context?.conflictReason ? { conflictReason: context.conflictReason } : {}),
  ...(context?.repeatIntent ? { repeatIntent: context.repeatIntent } : {}),
  identity: context?.identity ?? { modelId: null, source: 'unknown', verified: false },
}, callback);
