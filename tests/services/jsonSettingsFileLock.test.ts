import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import ts from 'typescript';
import { withJsonSettingsFileLock } from '../../src/services/jsonSettingsFileLock.js';
import { transactJsonSettings } from '../../src/services/jsonSettingsTransaction.js';

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('fixture deadline exceeded')), 10_000);
  })]); } finally { if (timer) clearTimeout(timer); }
}

describe('shared settings file lock', () => {
  let root: string; let target: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-shared-lock-'));
    target = path.join(root, 'settings.json'); fs.writeFileSync(target, '{"mcpServers":{}}');
  });
  afterEach(() => {
    expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    expect(path.basename(root).startsWith('mcphub-shared-lock-')).toBe(true);
    fs.rmSync(root, { recursive: true }); expect(fs.existsSync(root)).toBe(false);
  });
  test('retains ownership across awaits and permits nested atomic replacement', async () => {
    await withJsonSettingsFileLock(target, async () => {
      const record = JSON.parse(fs.readFileSync(path.join(root, '.settings.json.mcphub-lock'), 'utf8'));
      expect(record).toMatchObject({ version: 1, pid: process.pid });
      await Promise.resolve();
      transactJsonSettings(target, settings => ({ settings: { ...settings, users: [] }, value: null }));
    });
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).users).toEqual([]);
    expect(fs.readdirSync(root)).toEqual(['settings.json']);
  });
  test('read-only fallback never grants ownership to a nested write', () => {
    const open = jest.spyOn(fs, 'openSync').mockImplementation(() => {
      throw Object.assign(new Error('read-only fixture'), { code: 'EROFS' });
    });
    try {
      expect(withJsonSettingsFileLock(target, () => {
        expect(() => withJsonSettingsFileLock(target, () => 'write')).toThrow('read-only fixture');
        return 'read';
      }, true)).toBe('read');
    } finally { open.mockRestore(); }
  });
  test('another actual process cannot write until the owner releases the lock', async () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/services/jsonSettingsFileLock.ts'), 'utf8');
    fs.writeFileSync(path.join(root, 'lock.cjs'), ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText);
    const script = path.join(root, 'child.cjs');
    fs.writeFileSync(script, `const {withJsonSettingsFileLock}=require('./lock.cjs');
      withJsonSettingsFileLock(process.argv[2],async()=>{process.send('locked');
        await new Promise(resolve=>process.once('message',resolve));}).then(()=>process.exit(0),()=>process.exit(2));`);
    const child = spawn(process.execPath, [script, target], { windowsHide: true, stdio: ['ignore','ignore','ignore','ipc'] });
    let closed = false; const exited = once(child, 'exit').then(([code]) => { closed = true; return code; });
    try {
      await bounded(Promise.race([once(child, 'message'), exited.then(() => { throw new Error('fixture exited before locking'); })]));
      expect(() => transactJsonSettings(target, settings => ({ settings, value: null }))).toThrow('busy');
      child.send?.('release'); expect(await bounded(exited)).toBe(0);
      expect(withJsonSettingsFileLock(target, () => 'released')).toBe('released');
    } finally { if (!closed) child.kill(); await bounded(exited); }
  });
});
