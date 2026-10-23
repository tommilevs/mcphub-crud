import type { AttributionContextService } from './attributionContextService.js';
import { runWithCallAttribution } from './callAttribution.js';

/** The context belongs to the hub and must never become an upstream tool argument. */
export async function withAttributionHandshake(
  request: any,
  principal: string,
  service: AttributionContextService,
  handler: (request: any) => Promise<any>,
): Promise<any> {
  const input = request.params?.arguments?.hub_context;
  if (!input || !['search_tools', 'describe_tool', 'call_tool'].includes(request.params?.name)) {
    return handler(request);
  }
  const { hub_context: _context, ...args } = request.params.arguments;
  const cleaned = { ...request, params: { ...request.params, arguments: args } };
  let context;
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
    }
  } catch {
    // Attribution persistence must not prevent ordinary execution in compatible mode.
  }
  const result = await runWithCallAttribution(context ?? null, () => handler(cleaned));
  if (!context || !result || typeof result !== 'object') return result;
  return { ...result, _meta: { ...result._meta, 'dev.mcphub/context': {
    context_id: context.contextId, task_id: context.taskId, trace_id: context.traceId,
    model_segment_id: context.modelSegmentId,
    branch_id: context.branchId,
    ...(issuedKey ? { trace_key: issuedKey } : {}),
    model_identity: { model_id: context.identity.modelId, source: context.identity.source, verified: false },
  } } };
}
