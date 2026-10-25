import { prepareAcquisitionPublication, rollbackAcquisitionPublication } from '../../src/services/mcpAcquisitionPublicationSettings.js';
import type { McpSettings } from '../../src/types/index.js';
import type { AcquisitionManifest } from '../../src/services/mcpAcquisitionPlan.js';

const manifest: AcquisitionManifest = { schemaVersion: 1, serverName: 'new', targetGroup: 'target', transport: 'stdio',
  package: { ecosystem: 'npm', name: 'fixture', version: '1.0.0' }, source: { type: 'local_catalog', repository: null }, requiredInputs: [] };
const settings = (): McpSettings => ({ mcpServers: { existing: { command: 'existing.exe' } }, users: [],
  groups: [{ id: 'target', name: 'Target', servers: ['existing'] }, { id: 'other', name: 'Other', servers: [] }] });
const prepare = (input = settings()) => prepareAcquisitionPublication(input, manifest, 'operation', 'alice',
  { command: 'node.exe', args: ['owned/main.js'], cwd: 'owned' }, ['ping']);

test('prepares one private owned server and only the selected group without mutating input', () => {
  const original = settings(); const result = prepare(original);
  expect(original).toEqual(settings());
  expect(result.settings.mcpServers.new).toMatchObject({ owner: 'alice', visibility: 'private', env: {},
    options: { acquisitionOperationId: 'operation' } });
  expect(result.settings.groups![1]).toEqual(original.groups![1]);
  expect(result.receipt.entry).toEqual({ name: 'new', tools: ['ping'], prompts: [], resources: [] });
  expect(rollbackAcquisitionPublication(result.settings, result.receipt)).toEqual(original);
});
test('rejects existing servers and dangling group references without overwriting', () => {
  const input = settings(); input.mcpServers.NEW = { command: 'keep.exe' };
  expect(() => prepare(input)).toThrow('overwrite');
  const dangling = settings(); dangling.groups![1].servers = ['new'];
  expect(() => prepare(dangling)).toThrow('already references');
});
test('rollback preserves unrelated edits and refuses changed or adopted resources', () => {
  const result = prepare(); result.settings.mcpServers.unrelated = { command: 'keep.exe' };
  expect(rollbackAcquisitionPublication(result.settings, result.receipt).mcpServers.unrelated).toEqual({ command: 'keep.exe' });
  result.settings.mcpServers.new.command = 'user-edited.exe';
  expect(() => rollbackAcquisitionPublication(result.settings, result.receipt)).toThrow('reconciliation');
  const adopted = prepare(); adopted.settings.groups![1].servers = ['new'];
  expect(() => rollbackAcquisitionPublication(adopted.settings, adopted.receipt)).toThrow('reconciliation');
});
test('rollback retains new object memberships without creating mixed legacy arrays', () => {
  const result = prepare();
  (result.settings.groups![0].servers as any[]).push({ name: 'added-later', tools: ['read'] });
  const rollback = rollbackAcquisitionPublication(result.settings, result.receipt);
  expect(rollback.groups![0].servers.every(entry => typeof entry === 'object')).toBe(true);
  expect(rollback.groups![0].servers).toContainEqual({ name: 'added-later', tools: ['read'] });
});
