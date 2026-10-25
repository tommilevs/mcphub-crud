import { buildAcquisitionManifest, acquisitionManifestDigest } from '../../src/services/mcpAcquisitionPlan.js';
import type { MarketServer } from '../../src/types/index.js';

const catalog = {
  name: 'fixture', repository: { url: 'https://example.test/repo' },
  installations: { npm: { type: 'npm', command: 'npx', args: ['-y', '@fixture/mcp'], env: { KEY: 'do-not-store' } } },
  arguments: { KEY: { required: true } },
} as unknown as MarketServer;

test('pins package and produces metadata-only plan without catalog secret values', () => {
  const manifest = buildAcquisitionManifest(catalog, '1.2.3', 'group-1');
  expect(manifest).toMatchObject({ schemaVersion: 1, serverName: 'fixture', targetGroup: 'group-1',
    package: { ecosystem: 'npm', name: '@fixture/mcp', version: '1.2.3' }, requiredInputs: ['KEY'] });
  expect(JSON.stringify(manifest)).not.toMatch(/do-not-store|"env"|"command"/);
  expect(acquisitionManifestDigest(manifest)).toMatch(/^[a-f0-9]{64}$/);
  expect(acquisitionManifestDigest(manifest)).toBe(acquisitionManifestDigest(JSON.parse(JSON.stringify(manifest))));
  expect(acquisitionManifestDigest(manifest)).toBe(acquisitionManifestDigest({
    requiredInputs: manifest.requiredInputs, source: manifest.source, package: manifest.package,
    transport: manifest.transport, targetGroup: manifest.targetGroup, serverName: manifest.serverName,
    schemaVersion: manifest.schemaVersion,
  }));
  expect(acquisitionManifestDigest(manifest)).not.toBe(acquisitionManifestDigest({ ...manifest, targetGroup: 'other' }));
});

test('refuses floating versions and unsupported command shapes', () => {
  for (const version of ['latest', '^1.0.0', '1', '01.2.3', '1.0.0;exit', '1.0.0\n']) {
    expect(() => buildAcquisitionManifest(catalog, version, 'group')).toThrow();
  }
  for (const args of [['-y', 'package', '--execute'], ['https://example.test/payload'], ['-p', 'package']]) {
    expect(() => buildAcquisitionManifest({ ...catalog, installations: {
      npm: { type: 'npm', command: 'npx', args },
    } }, '1.0.0', 'group')).toThrow();
  }
  expect(() => buildAcquisitionManifest({ ...catalog, installations: {
    npm: { type: 'npm', command: 'powershell', args: ['package'] },
  } }, '1.0.0', 'group')).toThrow();
});
