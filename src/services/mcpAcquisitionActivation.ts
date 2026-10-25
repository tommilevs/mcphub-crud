import type { ServerInfo, Tool } from '../types/index.js';
import type { PublicationReceipt } from './mcpAcquisitionPublicationSettings.js';
import { getAppDataSource } from '../db/connection.js';
import { getNameSeparator } from '../config/index.js';
import { getSmartRoutingConfig } from '../utils/smartRouting.js';
type ListedTools = Parameters<typeof import('./mcpService.js').updateServerToolsCache>[1];

interface RuntimeObservationDependencies {
  refresh(name: string): Promise<void>;
  getServer(name: string): ServerInfo | undefined;
  wake(info: ServerInfo): Promise<void>;
  updateTools(info: ServerInfo, tools: ListedTools): void;
  sync(name: string, tools: Tool[]): Promise<void>;
  indexEnabled(): Promise<boolean>;
  indexedNames(name: string): Promise<string[]>;
  separator(): string;
}

/** Readiness uses an actual MCP list exchange; it never repeats the optional functional probe. */
export async function observeAcquisitionRuntime(receipt: PublicationReceipt, overrides?: RuntimeObservationDependencies) {
  let dependencies = overrides;
  if (!dependencies) {
    const runtime = await import('./mcpService.js');
    dependencies = { refresh: runtime.notifyToolChanged, getServer: runtime.getServerByName,
      wake: runtime.ensureServerReady, updateTools: runtime.updateServerToolsCache,
      sync: runtime.syncToolsAsVectorEmbeddings, separator: getNameSeparator,
      indexEnabled: async () => (await getSmartRoutingConfig()).enabled,
      indexedNames: async name => {
        const rows = await getAppDataSource().query(`SELECT metadata::jsonb->>'toolName' AS name
          FROM vector_embeddings WHERE content_type='tool' AND embedding IS NOT NULL
          AND metadata::jsonb->>'serverName'=$1`, [name]);
        return rows.map((row: { name: string }) => row.name);
      } };
  }
  const runtime = dependencies!;
  await runtime.refresh(receipt.serverName);
  const info = runtime.getServer(receipt.serverName);
  if (!info || info.config?.owner !== receipt.server.owner ||
      info.config?.options?.acquisitionOperationId !== receipt.operationId) {
    throw new Error('Activated runtime is not owned by this acquisition');
  }
  await runtime.wake(info);
  if (info.status !== 'connected' || !info.client) throw new Error('Acquired runtime is not connected');
  const tools: ListedTools = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await info.client.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
    tools.push(...result.tools);
    if (tools.length > 1000) throw new Error('Acquired runtime tool list exceeds the bound');
    if (!result.nextCursor) { cursor = undefined; break; }
    if (cursors.has(result.nextCursor)) throw new Error('Acquired runtime pagination repeats');
    cursors.add(result.nextCursor); cursor = result.nextCursor;
  }
  if (cursor) throw new Error('Acquired runtime pagination exceeds the bound');
  const names = tools.map(tool => tool.name);
  const expected = receipt.entry.tools;
  if (!Array.isArray(expected) || !expected.length || expected.some(name => !names.includes(name))) {
    throw new Error('Acquired runtime does not advertise all verified tools');
  }
  runtime.updateTools(info, tools);
  if (!await runtime.indexEnabled()) {
    return { serverName: receipt.serverName, tools: names, indexStatus: 'disabled' as const };
  }
  await runtime.sync(receipt.serverName, info.tools);
  const indexed = new Set(await runtime.indexedNames(receipt.serverName));
  if (expected.some(name => !indexed.has(`${receipt.serverName}${runtime.separator()}${name}`))) {
    throw new Error('Acquired runtime index is incomplete');
  }
  return { serverName: receipt.serverName, tools: names, indexStatus: 'verified' as const };
}
