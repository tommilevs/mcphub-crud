import type { NativeExecution } from '../types/index.js';

/** The agent supplies the Windows user's inherited environment, not the service gateway. */
export function interactiveNativeEnvironment(
  configured: Record<string,string> | undefined,
  resolved: Record<string,string>,
  injectedKeys: readonly string[],
): Record<string,string> {
  const keys=new Set([...Object.keys(configured??{}),...injectedKeys]);
  return Object.fromEntries([...keys].filter(key=>typeof resolved[key]==='string').map(key=>[key,resolved[key]]));
}

export function normalizeNativeExecution(value: unknown): NativeExecution | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native execution policy');
  const input=value as Record<string,unknown>;
  if(input.kind==='service') {
    if(input.sessionId!==undefined || input.pipeName!==undefined) throw new Error('Service execution cannot target a user session');
    return {kind:'service'};
  }
  if(input.kind!=='interactive' || !Number.isInteger(input.sessionId) || Number(input.sessionId)<1 || Number(input.sessionId)>0xffffffff)
    throw new Error('Interactive execution requires an explicit nonzero Windows session id');
  if(input.pipeName!==undefined && (typeof input.pipeName!=='string' || !/^mcphub-user-[A-Za-z0-9_.-]+$/.test(input.pipeName) || input.pipeName.length>128))
    throw new Error('Invalid user agent pipe');
  return {kind:'interactive',sessionId:Number(input.sessionId),...(input.pipeName!==undefined?{pipeName:input.pipeName as string}:{})};
}

export function interactiveExecutionRequest(value: unknown, nativeEligible: boolean) {
  const execution=normalizeNativeExecution(value);
  if(execution?.kind!=='interactive')return undefined;
  if(!nativeEligible)throw new Error('Interactive execution requires Windows native runtime and a compatible stdio configuration');
  return {kind:'interactive' as const,session_id:execution.sessionId,...(execution.pipeName?{pipe_name:execution.pipeName}:{})};
}
