import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

interface Invocation { id: string | number; params: { name: string; arguments?: unknown } }
/** MCP SDK v2 strips the JSON-RPC envelope ID from its parsed request. */
export const gatewayInvocation = (request: any, transportRequestId?: string | number): Invocation =>
  ({ ...request, id: transportRequestId ?? request.id });
interface GatewayProof {
  version: 1; adapterId: string; modelId: string; responseId: string; toolCallId: string;
  ownerSha256: string; invocationSha256: string; issuedAt: number; nonce: string; signature: string;
}
const canonical = (value: any): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new Error('Provenance requires JSON values');
};
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const invocationDigest = (request: Invocation) => sha256(canonical({ id: request.id,
  name: request.params.name, arguments: request.params.arguments ?? {} }));
const bounded = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= 255 && !/[\u0000-\u001f]/.test(value);

/** Reference instrumented gateway adapter: use the concrete provider response, never configured model inventory. */
export function createGatewayProof(response: any, toolCallId: string, request: Invocation,
  config: { adapterId: string; principal: string; secret: string; now?: number }): GatewayProof {
  if (![response?.id,response?.model,toolCallId,config.adapterId,config.principal].every(bounded) || config.secret.length < 32) {
    throw new Error('Invalid gateway evidence or configuration');
  }
  const calls = (response.choices ?? []).flatMap((choice: any) => choice.message?.tool_calls ?? [])
    .filter((call: any) => call.id === toolCallId);
  if (calls.length !== 1 || calls[0].type !== 'function' || calls[0].function?.name !== request.params.name ||
    canonical(JSON.parse(calls[0].function.arguments)) !== canonical(request.params.arguments ?? {})) {
    throw new Error('Provider tool call does not match invocation');
  }
  const payload = { version: 1 as const, adapterId: config.adapterId, modelId: response.model as string,
    responseId: response.id as string, toolCallId, ownerSha256: sha256(config.principal),
    invocationSha256: invocationDigest(request), issuedAt: config.now ?? Date.now(), nonce: randomUUID() };
  return { ...payload, signature: createHmac('sha256',config.secret).update(canonical(payload)).digest('hex') };
}

/** Verification requires an operator-trusted adapter and durable one-time nonce consumption. */
export async function verifyGatewayProof(value: unknown, request: Invocation, principal: string,
  resolveSecret: (adapterId: string) => string | undefined,
  consumeNonce: (adapterId: string, nonce: string, expiresAt: Date) => Promise<boolean>, now = Date.now()) {
  try {
    if (!value || typeof value !== 'object' || JSON.stringify(value).length > 4096) return null;
    const proof = value as GatewayProof;
    const { signature, ...payload } = proof;
    if (proof.version !== 1 || ![proof.adapterId,proof.modelId,proof.responseId,proof.toolCallId].every(bounded) ||
      !/^[0-9a-f-]{36}$/i.test(proof.nonce) || !Number.isSafeInteger(proof.issuedAt) ||
      proof.issuedAt > now+5000 || now-proof.issuedAt > 60000 ||
      !/^[0-9a-f]{64}$/.test(signature) || proof.ownerSha256 !== sha256(principal) ||
      proof.invocationSha256 !== invocationDigest(request)) return null;
    const secret = resolveSecret(proof.adapterId);
    if (!secret || secret.length < 32) return null;
    const expected = createHmac('sha256',secret).update(canonical(payload)).digest();
    if (!timingSafeEqual(expected,Buffer.from(signature,'hex'))) return null;
    if (!await consumeNonce(proof.adapterId,proof.nonce,new Date(proof.issuedAt+60000))) return null;
    return { adapterId: proof.adapterId, modelId: proof.modelId, responseId: proof.responseId,
      toolCallId: proof.toolCallId, invocationSha256: proof.invocationSha256 };
  } catch { return null; }
}
