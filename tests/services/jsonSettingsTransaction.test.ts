import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transactJsonSettings, SettingsTransactionConflict } from '../../src/services/jsonSettingsTransaction.js';

describe('current-settings atomic JSON replacement', () => {
  let root: string;
  let target: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-json-publication-'));
    target = path.join(root, 'settings.json');
    fs.writeFileSync(target, JSON.stringify({ mcpServers: { existing: { command: 'keep.exe' } }, groups: [], users: [] }));
  });
  afterEach(() => {
    expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    expect(path.basename(root).startsWith('mcphub-json-publication-')).toBe(true);
    fs.rmSync(root, { recursive: true });
    expect(fs.existsSync(root)).toBe(false);
  });
  test('replaces a complete document, preserves unrelated data and removes transaction files', () => {
    const result = transactJsonSettings(target, settings => {
      settings.mcpServers.new = { command: 'new.exe' };
      return { settings, value: 'receipt' };
    });
    expect(result.value).toBe('receipt'); expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers).toEqual({ existing: { command: 'keep.exe' }, new: { command: 'new.exe' } });
    expect(fs.readdirSync(root)).toEqual(['settings.json']);
  });
  test('rejects a changed file rather than overwriting an external edit', () => {
    expect(() => transactJsonSettings(target, settings => {
      fs.writeFileSync(target, JSON.stringify({ mcpServers: { external: { command: 'external.exe' } } }));
      settings.mcpServers.new = { command: 'new.exe' };
      return { settings, value: null };
    })).toThrow(SettingsTransactionConflict);
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers).toEqual({ external: { command: 'external.exe' } });
    expect(fs.readdirSync(root)).toEqual(['settings.json']);
  });
  test('rejects an existing cooperative lock and does not remove it', () => {
    const lock = path.join(root, '.settings.json.mcphub-lock'); fs.writeFileSync(lock, 'other-participant');
    expect(() => transactJsonSettings(target, settings => ({ settings, value: null }))).toThrow(SettingsTransactionConflict);
    expect(fs.readFileSync(lock, 'utf8')).toBe('other-participant');
  });
  test('mutation failure preserves the original document and releases its own lock', () => {
    const original = fs.readFileSync(target, 'utf8');
    expect(() => transactJsonSettings(target, () => { throw new Error('fixture failure'); })).toThrow('fixture failure');
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(fs.readdirSync(root)).toEqual(['settings.json']);
  });
  test('stale expected revisions reject before invoking a mutation', () => {
    const mutate = jest.fn(settings => ({ settings, value: null }));
    expect(() => transactJsonSettings(target, mutate, 'stale')).toThrow(SettingsTransactionConflict);
    expect(mutate).not.toHaveBeenCalled(); expect(fs.readdirSync(root)).toEqual(['settings.json']);
  });
});
