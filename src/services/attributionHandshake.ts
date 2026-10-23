import type { AttributionContextService, AttributionContextReference } from './attributionContextService.js';
import { runWithCallAttribution, getCallAttribution } from './callAttribution.js';
import { extractDiscoveryEvidence } from './discoveryEvidence.js';

export function stripAttributionInput(request: any) {
  const params = request.params ?? {};
  const smart = ['search_tools', 'describe_tool', 'call_tool'].includes(params.name);
  const { hub_context: _context, ...args } = params.arguments ?? {};
  const { 'dev.mcphub/attribution': _attribution, ...remainingMeta } = params._meta ?? {};
  return { ...request, params: { ...params,
    ...(smart && params.arguments ? { arguments: args } : {}),
    ...(params._meta ? { _meta: remainingMeta } : {}),
  } };
}

/** The context belongs to the hub and must never become an upstream tool argument. */
export async function withAttributionHandshake(
  request: any,
  principal: string,
  service: AttributionContextService,
  handler: (request: any) => Promise<any>,
): Promise<any> {
  const hub = request.params?.arguments?.hub_context;
  const meta = request.params?._meta?.['dev.mcphub/attribution'];
  if ((!hub && !meta) || !['search_tools', 'describe_tool', 'call_tool'].includes(request.params?.name)) {
    return handler(request);
  }
  const cleaned = stripAttributionInput(request);
  const validObject = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
  const keyConflict = validObject(hub) && validObject(meta) && hub.trace_key && meta.trace_key && hub.trace_key !== meta.trace_key;
  const modelConflict = validObject(hub) && validObject(meta) && hub.model_claim && meta.model_id && hub.model_claim !== meta.model_id;
  if (keyConflict || modelConflict) {
    return runWithCallAttribution({ contextId: null, taskId: null, traceId: null, modelSegmentId: null,
      identity: { modelId: null, source: 'unknown', verified: false },
      conflictReason: keyConflict ? 'conflicting_trace_keys' : 'conflicting_model_claims',
    }, () => handler(cleaned));
  }
  const input = validObject(hub)
    ? { ...hub, trace_key: hub.trace_key ?? (validObject(meta) ? meta.trace_key : undefined) }
    : hub ?? (validObject(meta) ? { trace_key: meta.trace_key } : meta);
  let context: AttributionContextReference | null | undefined;
  let issuedKey: string | undefined;
  try {
    if (typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 4096) {
      return handler(cleaned);
    }
    if (input.action === 'start' && (input.model_claim == null || typeof input.model_claim === 'string')) {
      const issued = await service.start(principal, {
        modelClaim: input.model_claim, clientNameClaim: input.client_name_claim,
        clientInstanceHint: input.client_instance_hint, agentRunHint: input.agent_run_hint,
        taskHint: input.task_hint,
      });
      context = issued;
      issuedKey = issued.traceKey;
    } else if (['rotate', 'fork'].includes(input.action) && typeof input.trace_key === 'string' &&
      (input.model_claim == null || typeof input.model_claim === 'string')) {
      const issued = input.action === 'fork'
        ? await service.fork(principal, input.trace_key, input.model_claim)
        : await service.rotate(principal, input.trace_key, input.model_claim);
      context = issued;
      issuedKey = issued?.traceKey;
    } else if (!input.action && typeof input.trace_key === 'string') {
      context = await service.resolve(principal, input.trace_key);
      const currentClaim = input.model_claim ?? meta?.model_id;
      if (context && typeof currentClaim === 'string' && currentClaim !== context.identity.modelId) {
        return runWithCallAttribution({ contextId: context.contextId, taskId: context.taskId,
          traceId: context.traceId, modelSegmentId: null,
          identity: { modelId: null, source: 'unknown', verified: false },
          conflictReason: 'model_claim_differs_from_segment',
        }, () => handler(cleaned));
      }
    }
  } catch {
    // Attribution persistence must not prevent ordinary execution in compatible mode.
  }
  const result = await runWithCallAttribution(context ?? null, async () => {
    const result = await handler(cleaned);
    const callId = getCallAttribution()?.callId;
    const evidence = extractDiscoveryEvidence(request.params.name, result);
    if (context && callId && evidence) {
      try { await service.recordDiscovery(context, callId, evidence); }
      catch { /* Discovery telemetry must never change the returned tool result. */ }
    }
    return result;
  });
  if (!context || !result || typeof result !== 'object') return result;
  return { ...result, _meta: { ...result._meta, 'dev.mcphub/context': {
    context_id: context.contextId, task_id: context.taskId, trace_id: context.traceId,
    model_segment_id: context.modelSegmentId,
    branch_id: context.branchId,
    ...(issuedKey ? { trace_key: issuedKey } : {}),
    model_identity: { model_id: context.identity.modelId, source: context.identity.source, verified: false },
  } } };
}
