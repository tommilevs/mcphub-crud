import { isDeepStrictEqual } from 'node:util';
import type { McpSettings, ServerConfig, IGroupServerConfig } from '../types/index.js';
import type { AcquisitionManifest } from './mcpAcquisitionPlan.js';

export interface PublicationReceipt {
  operationId: string; serverName: string; groupId: string;
  server: ServerConfig; entry: IGroupServerConfig;
  legacyStrings: string[];
}
export interface PostgresPublicationReservation {
  storage: 'postgres'; serverId: string; storedServerDigest: string; receipt: PublicationReceipt;
}
const nameOf = (entry: string | IGroupServerConfig) => typeof entry === 'string' ? entry : entry.name;
// Receipts/configuration cross JSON storage and VM realms; compare their persisted representation.
const equal = (left: unknown, right: unknown) => isDeepStrictEqual(
  JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));

/** Pure transaction preparation; the persistence adapter must atomically apply this to current settings. */
export function prepareAcquisitionPublication(settings: McpSettings, manifest: AcquisitionManifest,
  operationId: string, owner: string, launch: { command: string; args: string[]; cwd: string },
  verifiedTools: string[], secretReferences: Record<string, string> = {}) {
  if (!owner.trim() || !operationId || !launch.command || !launch.cwd || !Array.isArray(launch.args) ||
      !launch.args.every(arg => typeof arg === 'string') || !verifiedTools.length || verifiedTools.length > 1000 ||
      verifiedTools.some(tool => typeof tool !== 'string' || !tool.trim() || tool.length > 255)) {
    throw new Error('Invalid acquisition publication input');
  }
  if (Object.keys(secretReferences).some(name => !manifest.requiredInputs.includes(name)) ||
      manifest.requiredInputs.some(name => !secretReferences[name])) throw new Error('Unreviewed or missing server configuration');
  const target = settings.groups?.find(group => group.id === manifest.targetGroup);
  if (!target) throw new Error('Publication target group no longer exists');
  const name = manifest.serverName;
  if (Object.keys(settings.mcpServers).some(existing => existing.toLowerCase() === name.toLowerCase())) {
    throw new Error('Publication would overwrite an existing server');
  }
  if (settings.groups?.some(group => group.servers.some(entry => nameOf(entry).toLowerCase() === name.toLowerCase()))) {
    throw new Error('An existing group already references this server name');
  }
  if (target.servers.some(entry => typeof entry !== 'string' && entry.alias?.trim().toLowerCase() === name.toLowerCase())) {
    throw new Error('Publication would collide with an existing group alias');
  }
  const server: ServerConfig = { type: 'stdio', command: launch.command, args: [...launch.args], env: {},
    nativeSecretRefs: { ...secretReferences }, owner, visibility: 'private', enabled: true, startOnDemand: true,
    options: { nativeWorkingDirectory: launch.cwd, nativeExecution: { kind: 'service' }, acquisitionOperationId: operationId } };
  const entry: IGroupServerConfig = { name, tools: [...new Set(verifiedTools)].sort(), prompts: [], resources: [] };
  const next = structuredClone(settings);
  next.mcpServers = { ...next.mcpServers, [name]: server };
  const group = next.groups!.find(group => group.id === manifest.targetGroup)!;
  const legacyStrings = group.servers.filter((entry): entry is string => typeof entry === 'string');
  group.servers = [...group.servers.map(entry => typeof entry === 'string'
    ? { name: entry, tools: 'all' as const, prompts: 'all' as const, resources: 'all' as const } : entry), entry];
  return { settings: next, receipt: structuredClone({ operationId, serverName: name,
    groupId: manifest.targetGroup, server, entry, legacyStrings }) satisfies PublicationReceipt };
}

/** Refuse rollback after adoption or edits; never restore an old whole-settings snapshot. */
export function rollbackAcquisitionPublication(settings: McpSettings, receipt: PublicationReceipt) {
  const current = settings.mcpServers[receipt.serverName];
  const target = settings.groups?.find(group => group.id === receipt.groupId);
  const entries = target?.servers.filter(entry => nameOf(entry) === receipt.serverName) ?? [];
  const adopted = settings.groups?.some(group => group.id !== receipt.groupId && group.servers.some(entry => nameOf(entry) === receipt.serverName));
  if (adopted || (current && !equal(current, receipt.server)) ||
      entries.length > 1 || entries.some(entry => !equal(entry, receipt.entry))) {
    throw new Error('Publication changed after application; rollback requires reconciliation');
  }
  const next = structuredClone(settings);
  delete next.mcpServers[receipt.serverName];
  const group = next.groups?.find(item => item.id === receipt.groupId);
  if (group) {
    const remaining = group.servers.filter(entry => nameOf(entry) !== receipt.serverName);
    const restoreLegacy = remaining.every(entry => typeof entry === 'string' ||
      (receipt.legacyStrings.includes(entry.name) && equal(entry, { name: entry.name, tools: 'all', prompts: 'all', resources: 'all' })));
    group.servers = (restoreLegacy ? remaining.map(nameOf) : remaining) as typeof group.servers;
  }
  return next;
}
