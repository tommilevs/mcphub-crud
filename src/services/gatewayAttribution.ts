import { verifyGatewayProof } from './gatewayProvenance.js';
import { getCallAttribution, withCallAttributionOverride } from './callAttribution.js';

/** Operator config only; never accept adapter keys from client request metadata. */
const resolveAdapterSecret = (adapterId: string): string | undefined => {
  try {
    const adapters = JSON.parse(process.env.MCPHUB_GATEWAY_ADAPTER_KEYS ?? '{}');
    return Object.prototype.hasOwnProperty.call(adapters,adapterId) && typeof adapters[adapterId] === 'string' ? adapters[adapterId] : undefined;
  } catch { return undefined; }
};

export async function withGatewayAttribution(request: any, cleaned: any, principal: string,
  repository: { consumeGatewayNonce(adapter: string, nonce: string, expires: Date): Promise<boolean> },
  handler: (request: any) => Promise<any>, resolveSecret = resolveAdapterSecret) {
  const proof = request.params?._meta?.['dev.mcphub/provenance'];
  if (!proof || !getCallAttribution()) return handler(cleaned);
  const verified = await verifyGatewayProof(proof, request, principal,resolveSecret,
    (adapter,nonce,expires) => repository.consumeGatewayNonce(adapter,nonce,expires));
  if (!verified) return handler(cleaned);
  const current = getCallAttribution()!;
  const claimedModelId = current.identity.modelId;
  const provenance = { ...verified,claimedModelId,causalCorrelationVerified:true as const };
  const conflictReason = current.conflictReason || (claimedModelId && claimedModelId !== verified.modelId ? 'gateway_model_differs_from_claim' : undefined);
  return withCallAttributionOverride({identity:{modelId:verified.modelId,source:'gateway_observed',verified:true},provenance,
    ...(conflictReason ? {conflictReason} : {})},async()=>{
    const result = await handler(cleaned);
    return result && typeof result === 'object' ? {...result,_meta:{...result._meta,
      'dev.mcphub/provenance':{...provenance,identity_source:'gateway_observed',verified:true,...(conflictReason?{conflict_reason:conflictReason}:{})}}} : result;
  });
}
