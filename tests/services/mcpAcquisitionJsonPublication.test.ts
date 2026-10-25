import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishJsonAcquisition, rollbackJsonAcquisition } from '../../src/services/mcpAcquisitionJsonPublication.js';
import type { AcquisitionManifest } from '../../src/services/mcpAcquisitionPlan.js';
import { getSettingsGeneration } from '../../src/config/index.js';

describe('acquisition JSON publication persistence', () => {
  let root: string; let target: string;
  const manifest: AcquisitionManifest = { schemaVersion: 1, serverName: 'fixture', targetGroup: 'target', transport: 'stdio',
    package: { ecosystem: 'npm', name: 'fixture', version: '1.0.0' }, source: { type: 'local_catalog', repository: null }, requiredInputs: [] };
  const input = { manifest, operationId: 'operation', owner: 'alice',
    launch: { command: 'node.exe', args: ['fixture.js'], cwd: 'owned' }, verifiedTools: ['ping'] };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-json-publication-'));
    target = path.join(root, 'settings.json');
    fs.writeFileSync(target, JSON.stringify({ mcpServers: { existing: { command: 'keep.exe' } },
      groups: [{ id: 'target', name: 'Target', servers: ['existing'] }] }));
  });
  afterEach(() => {
    expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    expect(path.basename(root).startsWith('mcphub-json-publication-')).toBe(true);
    fs.rmSync(root, { recursive: true }); expect(fs.existsSync(root)).toBe(false);
  });
  test('persists recovery receipt before applying and rolls back only its resources', async () => {
    let durable: any;
    const generation = getSettingsGeneration();
    const result = await publishJsonAcquisition(target, input, async reservation => {
      expect(JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers.fixture).toBeUndefined();
      durable = JSON.parse(JSON.stringify(reservation)); return true;
    });
    expect(durable).toMatchObject({ storage: 'json', settingsPath: target, receipt: { operationId: 'operation' } });
    expect(result.receipt).toEqual(durable.receipt);
    expect(getSettingsGeneration()).toBeGreaterThan(generation);
    const applied = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(applied.mcpServers.fixture.owner).toBe('alice');
    applied.mcpServers.unrelated = { command: 'preserve.exe' };
    fs.writeFileSync(target, JSON.stringify(applied));
    await rollbackJsonAcquisition(target, durable);
    const rolled = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(rolled.mcpServers.fixture).toBeUndefined();
    expect(rolled.mcpServers.unrelated.command).toBe('preserve.exe');
    expect(rolled.groups[0].servers).toEqual(['existing']);
  });
  test('failed durable reservation leaves settings unchanged', async () => {
    const before=fs.readFileSync(target,'utf8');
    await expect(publishJsonAcquisition(target,input,async()=>false)).rejects.toThrow('reservation');
    expect(fs.readFileSync(target,'utf8')).toBe(before);
    expect(fs.readdirSync(root)).toEqual(['settings.json']);
  });
  test('external edit during reservation is preserved and cannot be overwritten', async () => {
    await expect(publishJsonAcquisition(target,input,async()=>{
      fs.writeFileSync(target,JSON.stringify({mcpServers:{external:{command:'external.exe'}}})); return true;
    })).rejects.toThrow('revision');
    expect(JSON.parse(fs.readFileSync(target,'utf8')).mcpServers).toEqual({external:{command:'external.exe'}});
  });
  test('rollback refuses a receipt for another settings file', async () => {
    let durable: any;
    await publishJsonAcquisition(target,input,async value=>{durable=value;return true;});
    await expect(rollbackJsonAcquisition(path.join(root,'other.json'),durable)).rejects.toThrow('different settings');
    expect(JSON.parse(fs.readFileSync(target,'utf8')).mcpServers.fixture).toBeDefined();
  });
  test('rollback preserves user edits and requires reconciliation', async () => {
    let durable: any;
    await publishJsonAcquisition(target,input,async value=>{durable=value;return true;});
    const edited=JSON.parse(fs.readFileSync(target,'utf8'));
    edited.mcpServers.fixture.enabled=false;
    fs.writeFileSync(target,JSON.stringify(edited));
    const before=fs.readFileSync(target,'utf8');
    await expect(rollbackJsonAcquisition(target,durable)).rejects.toThrow('reconciliation');
    expect(fs.readFileSync(target,'utf8')).toBe(before);
  });
});
