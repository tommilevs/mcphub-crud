import { Client } from '@modelcontextprotocol/client';
import { NativeRuntimeTransport } from './nativeRuntimeTransport.js';
import { resolveNativeInstalledPackage } from './nativeRuntimeSecretService.js';
import type { AcquisitionManifest } from './mcpAcquisitionPlan.js';
import { acquisitionManifestDigest } from './mcpAcquisitionPlan.js';
import { getAppDataSource } from '../db/connection.js';
import { getToolResultRepository } from './toolResultHistoryRegistry.js';
import { ToolResultHistoryService } from './toolResultHistoryService.js';
import { AcquisitionOperationRepository } from './mcpAcquisitionOperation.js';

/** Discovery plus an optional exact-plan-authorized empty-argument probe; no publication. */
export async function inspectAcquiredMcp(operationId: string, manifest: AcquisitionManifest,
  secretReferences: Record<string, string> = {}, probeContext?: {
    username: string; history?: Pick<ToolResultHistoryService, 'capture'>;
  }) {
  let history: Pick<ToolResultHistoryService, 'capture'> | undefined;
  if (manifest.probe) {
    if (!probeContext?.username?.trim()) throw new Error('An authenticated probe owner is required');
    const approved = await getAppDataSource().query(`SELECT p.manifest,p.manifest_digest
      FROM mcp_acquisition_operations o JOIN mcp_acquisition_plans p ON p.plan_id=o.plan_id
      WHERE o.operation_id=$1 AND o.owner=$2 AND o.state='verifying'
      AND NOT o.cancel_requested AND NOT o.requires_reconciliation`, [operationId, probeContext.username]);
    const digest = acquisitionManifestDigest(manifest);
    if (!approved.length || approved[0].manifest_digest !== digest || acquisitionManifestDigest(approved[0].manifest) !== digest) {
      throw new Error('The exact probe plan is not authorized for this operation');
    }
    const repository = probeContext.history ? undefined : getToolResultRepository();
    history = probeContext.history ?? (repository ? new ToolResultHistoryService(repository) : undefined);
    if (!history) throw new Error('Probe result history is unavailable');
  }
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
      if (!result.nextCursor) {
        if (!manifest.probe) return { verification: 'discovery_only' as const, tools };
        if (!tools.some(tool => tool.name === manifest.probe!.tool)) throw new Error('The reviewed probe tool is not advertised');
        // Atomic owner/digest/cancellation gate: an uncertain or concurrent probe cannot replay.
        const operations = new AcquisitionOperationRepository(getAppDataSource());
        const probeClaim = await operations.claimProbe(probeContext!.username, operationId, acquisitionManifestDigest(manifest));
        if (!probeClaim) throw new Error('Probe authorization is no longer active or a probe has already started');
        try {
        const started = Date.now();
        const probeResult = await client.callTool({ name: manifest.probe.tool, arguments: {} }, { timeout: 30_000 });
        const saved = await history!.capture({ server: manifest.serverName, tool: manifest.probe.tool,
          arguments: {}, result: probeResult, durationMs: Date.now() - started,
          status: probeResult.isError ? 'error' : 'success', username: probeContext!.username,
          group: manifest.targetGroup, objective: `acquisition:${operationId}`, capturePayload: true });
        if (!saved?.payloadAvailable) throw new Error('Probe RAW result could not be retained');
        if (!await operations.completeProbe(probeContext!.username, operationId, probeClaim, saved.resultId)) {
          throw new Error('Probe evidence could not be attached to its operation');
        }
        return { verification: probeResult.isError ? 'functional_failed' as const : 'functional' as const,
          tools, probe: { tool: manifest.probe.tool, resultId: saved.resultId } };
        } catch {
          try { await operations.uncertainProbe(probeContext!.username, operationId, probeClaim); } catch { /* probe claim still prevents replay */ }
          throw new Error('Probe outcome or RAW persistence requires reconciliation; automatic retry is disabled');
        }
      }
      if (seen.has(result.nextCursor)) throw new Error('Installed tool catalog pagination did not advance');
      seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new Error('Installed tool catalog exceeds the inspection page limit');
  } finally {
    await client.close();
  }
}
