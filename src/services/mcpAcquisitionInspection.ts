import { Client } from '@modelcontextprotocol/client';
import { NativeRuntimeTransport } from './nativeRuntimeTransport.js';
import { resolveNativeInstalledPackage } from './nativeRuntimeSecretService.js';
import type { AcquisitionManifest } from './mcpAcquisitionPlan.js';

/** Protocol discovery only; no arbitrary tool call or group publication. */
export async function inspectAcquiredMcp(operationId: string, manifest: AcquisitionManifest,
  secretReferences: Record<string, string> = {}) {
  if (Object.keys(secretReferences).some(name => !manifest.requiredInputs.includes(name))) {
    throw new Error('Server configuration contains an unreviewed input');
  }
  for (const name of manifest.requiredInputs) {
    if (typeof secretReferences[name] !== 'string' || !secretReferences[name].trim()) {
      throw new Error('Required server configuration has not been supplied');
    }
  }
  if (Object.values(secretReferences).some(reference => typeof reference !== 'string' || !reference.trim() || reference.length > 255)) {
    throw new Error('Invalid server secret reference');
  }
  const resolved = await resolveNativeInstalledPackage(operationId, manifest.package.name, manifest.package.version);
  const spec = resolved.spec as Record<string, unknown> | undefined;
  const identity = resolved.package as Record<string, unknown> | undefined;
  if (resolved.verification !== 'package_metadata' || identity?.name !== manifest.package.name || identity.version !== manifest.package.version ||
      typeof spec?.command !== 'string' || typeof spec.cwd !== 'string' || !Array.isArray(spec.args) || !spec.args.every(arg => typeof arg === 'string')) {
    throw new Error('Installed package resolution does not match the reviewed plan');
  }
  const transport = new NativeRuntimeTransport({ id: `acquisition-${operationId}`, command: spec.command,
    args: spec.args, cwd: spec.cwd, env: {}, secret_env: secretReferences,
    restart_limit: 0, streaming: true, initialize_timeout_ms: 30_000, request_timeout_ms: 30_000 });
  const client = new Client({ name: 'mcphub-acquisition-inspection', version: '1.1.8' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const tools: Array<{ name: string; description?: string; inputSchema: unknown }> = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
      tools.push(...result.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })));
      if (tools.length > 1000) throw new Error('Installed tool catalog exceeds the inspection limit');
      if (!result.nextCursor) return { verification: 'discovery_only' as const, tools };
      if (seen.has(result.nextCursor)) throw new Error('Installed tool catalog pagination did not advance');
      seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new Error('Installed tool catalog exceeds the inspection page limit');
  } finally {
    await client.close();
  }
}
