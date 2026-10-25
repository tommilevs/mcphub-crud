import { createHash } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { Server } from '../db/entities/Server.js';
import { Group } from '../db/entities/Group.js';
import type { McpSettings } from '../types/index.js';
import { mirrorStartOnDemandIntoOptions } from '../utils/serverConfigPersistence.js';
import { assertSmartRoutingNameAvailable } from '../utils/smartRoutingPath.js';
import { AcquisitionOperationRepository } from './mcpAcquisitionOperation.js';
import { prepareAcquisitionPublication, rollbackAcquisitionPublication, type PostgresPublicationReservation } from './mcpAcquisitionPublicationSettings.js';
import type { JsonPublicationInput } from './mcpAcquisitionJsonPublication.js';
export class AcquisitionPublicationCommitUnknown extends Error {}

/** Persisted row identity, including defaults and sync metadata, excluding timestamps. */
export function acquisitionStoredServerDigest(server: Server): string {
  const fields = Object.entries(server).filter(([key]) => !['createdAt', 'updatedAt'].includes(key))
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(fields))).digest('hex');
}

/** Short validation transaction. Runtime/index work must happen outside this callback. */
export async function withValidatedPostgresPublication<T>(db: Pick<DataSource, 'transaction'>,
  reservation: PostgresPublicationReservation, work: (manager: EntityManager) => Promise<T>) {
  if (reservation.storage !== 'postgres') throw new Error('Publication belongs to a different settings store');
  return db.transaction('SERIALIZABLE', async manager => {
    await manager.query('LOCK TABLE "servers", "groups" IN SHARE ROW EXCLUSIVE MODE');
    const receipt = reservation.receipt;
    const server = await manager.getRepository(Server).findOneBy({ id: reservation.serverId, name: receipt.serverName });
    if (!server || acquisitionStoredServerDigest(server) !== reservation.storedServerDigest) {
      throw new Error('Publication changed after application; activation requires reconciliation');
    }
    const groups = await manager.getRepository(Group).find({ select: { id: true, name: true, servers: true } });
    const current: McpSettings = { mcpServers: { [receipt.serverName]: receipt.server },
      groups: groups.map(group => ({ id: group.id, name: group.name, servers: group.servers })) as McpSettings['groups'] };
    rollbackAcquisitionPublication(current, receipt); // Comparison only; no returned data is persisted.
    if (!groups.some(group => group.id === receipt.groupId && group.servers.some(entry =>
      (typeof entry === 'string' ? entry : entry.name) === receipt.serverName))) {
      throw new Error('Publication membership disappeared; activation requires reconciliation');
    }
    return work(manager);
  });
}

export async function withRemovedPostgresPublication<T>(db: Pick<DataSource, 'transaction'>,
  reservation: PostgresPublicationReservation, work: (manager: EntityManager) => Promise<T>) {
  return db.transaction('SERIALIZABLE', async manager => {
    await manager.query('LOCK TABLE "servers", "groups" IN SHARE ROW EXCLUSIVE MODE');
    const receipt = reservation.receipt;
    const remaining = await manager.getRepository(Server).findOne({ where: [{ id: reservation.serverId }, { name: receipt.serverName }] });
    const groups = await manager.getRepository(Group).find({ select: { servers: true } });
    if (remaining || groups.some(group => group.servers.some(entry =>
      (typeof entry === 'string' ? entry : entry.name).toLowerCase() === receipt.serverName.toLowerCase()))) {
      throw new Error('Removed publication was changed or adopted; rollback requires reconciliation');
    }
    return work(manager);
  });
}

/** Remove only the unchanged row and owned membership. Runtime cleanup and lifecycle commit follow separately. */
export async function rollbackPostgresAcquisition(db: Pick<DataSource, 'transaction'>,
  reservation: PostgresPublicationReservation) {
  if (reservation.storage !== 'postgres') throw new Error('Publication belongs to a different settings store');
  return db.transaction('SERIALIZABLE', async manager => {
    await manager.query('LOCK TABLE "servers", "groups" IN SHARE ROW EXCLUSIVE MODE');
    const servers = manager.getRepository(Server), groups = manager.getRepository(Group);
    const receipt = reservation.receipt;
    const owned = await servers.find({ where: [{ id: reservation.serverId }, { name: receipt.serverName }] });
    if (owned.length > 1 || owned.some(server => server.id !== reservation.serverId || server.name !== receipt.serverName ||
        acquisitionStoredServerDigest(server) !== reservation.storedServerDigest)) {
      throw new Error('Publication changed after application; rollback requires reconciliation');
    }
    const names = await servers.find({ select: { name: true } });
    const currentGroups = await groups.find({ select: { id: true, name: true, servers: true } });
    const current: McpSettings = { mcpServers: Object.fromEntries(names.map(server => [server.name, {}])),
      groups: currentGroups.map(group => ({ id: group.id, name: group.name, servers: group.servers })) as McpSettings['groups'] };
    // Row digest validation above includes every persisted field and the row identity.
    // Reuse the common membership/adoption checks with the equivalent public configuration.
    if (owned.length) current.mcpServers[receipt.serverName] = receipt.server;
    const next = rollbackAcquisitionPublication(current, receipt);
    if (owned.length) await servers.delete({ id: reservation.serverId });
    const target = next.groups?.find(group => group.id === receipt.groupId);
    if (target) await groups.update({ id: target.id }, { servers: target.servers });
    return { digest: createHash('sha256').update(JSON.stringify({ serverId: reservation.serverId,
      removed: true, groupId: receipt.groupId, servers: target?.servers ?? null })).digest('hex') };
  });
}

/** Settings and the operation journal share one PostgreSQL transaction. No MCP process is started here. */
export async function publishPostgresAcquisition(db: Pick<DataSource, 'transaction'>,
  input: JsonPublicationInput, claimId: string) {
  assertSmartRoutingNameAvailable(input.manifest.serverName);
  let preparedToCommit = false;
  try { return await db.transaction('SERIALIZABLE', async manager => {
    // Lock both collections to cover case-insensitive collisions and dangling references,
    // including inserts that row locks on the target alone cannot exclude.
    await manager.query('LOCK TABLE "servers", "groups" IN SHARE ROW EXCLUSIVE MODE');
    const servers = manager.getRepository(Server), groups = manager.getRepository(Group);
    const names = await servers.find({ select: { name: true } });
    const currentGroups = await groups.find({ select: { id: true, name: true, servers: true } });
    const current: McpSettings = { mcpServers: Object.fromEntries(names.map(server => [server.name, {}])),
      groups: currentGroups.map(group => ({ id: group.id, name: group.name, servers: group.servers })) as McpSettings['groups'] };
    const prepared = prepareAcquisitionPublication(current, input.manifest, input.operationId, input.owner,
      input.launch, input.verifiedTools, input.secretReferences);
    const config = prepared.receipt.server;
    const created = await servers.save(servers.create({ name: input.manifest.serverName, type: config.type,
      command: config.command, args: config.args, env: config.env, nativeSecretRefs: config.nativeSecretRefs,
      enabled: config.enabled, owner: config.owner, visibility: config.visibility,
      options: mirrorStartOnDemandIntoOptions(config.options, config.startOnDemand === true, config.idleTimeoutMs) }));
    const stored = await servers.findOneByOrFail({ id: created.id });
    const reservation: PostgresPublicationReservation = { storage: 'postgres', serverId: stored.id,
      storedServerDigest: acquisitionStoredServerDigest(stored), receipt: prepared.receipt };
    const operations = new AcquisitionOperationRepository({ query: (sql, args) => manager.query(sql, args) });
    if (!await operations.reservePublication(input.owner, input.operationId, claimId, reservation)) {
      throw new Error('Publication reservation could not be committed');
    }
    const target = prepared.settings.groups!.find(group => group.id === input.manifest.targetGroup)!;
    await groups.update({ id: target.id }, { servers: target.servers });
    const digest = createHash('sha256').update(JSON.stringify({ server: reservation.storedServerDigest,
      groupId: target.id, entry: prepared.receipt.entry })).digest('hex');
    if (!await operations.recordPublicationApplied(input.owner, input.operationId, claimId, digest)) {
      throw new Error('Publication outcome could not be committed');
    }
    preparedToCommit = true;
    return { reservation, digest };
  }); } catch (error) {
    if (preparedToCommit) throw new AcquisitionPublicationCommitUnknown('Publication commit outcome requires reconciliation');
    throw error;
  }
}
