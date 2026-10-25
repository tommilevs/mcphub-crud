import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('real JSON factory preserves concurrent server creations and coordinated publication writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-dao-transaction-'));
  const target = path.join(root, 'settings.json');
  const previous = process.env.MCPHUB_SETTING_PATH;
  process.env.MCPHUB_SETTING_PATH = target;
  fs.writeFileSync(target, JSON.stringify({ mcpServers: {}, groups: [], users: [] }));
  try {
    jest.resetModules();
    const { JsonFileDaoFactory } = await import('../../src/dao/DaoFactory.js');
    const { withJsonDaoTransaction } = await import('../../src/services/jsonDaoTransaction.js');
    const { transactJsonSettings } = await import('../../src/services/jsonSettingsTransaction.js');
    const { clearSettingsCache } = await import('../../src/config/index.js');
    const factory = JsonFileDaoFactory.getInstance(); factory.resetInstances();
    const servers = factory.getServerDao();
    await Promise.all([
      ...Array.from({ length: 10 }, (_, index) => servers.create({ name: `server-${index}`, command: 'fixture.exe' })),
      withJsonDaoTransaction(() => {
        transactJsonSettings(target, settings => {
          settings.mcpServers.published = { command: 'owned-fixture.exe' };
          return { settings, value: null };
        });
        clearSettingsCache();
      }),
    ]);
    expect(Object.keys(JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers)).toHaveLength(11);
    expect((await servers.findAll()).map(server => server.name)).toContain('published');
  } finally {
    if (previous === undefined) delete process.env.MCPHUB_SETTING_PATH; else process.env.MCPHUB_SETTING_PATH = previous;
    expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    expect(path.basename(root).startsWith('mcphub-dao-transaction-')).toBe(true);
    fs.rmSync(root, { recursive: true }); expect(fs.existsSync(root)).toBe(false);
  }
});
