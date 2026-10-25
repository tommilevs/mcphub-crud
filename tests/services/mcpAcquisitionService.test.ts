import { proposeMcpServers } from '../../src/services/mcpAcquisitionService.js';
import { MarketServer } from '../../src/types/index.js';

const server = (name: string, description: string): MarketServer => ({
  name, display_name: name, description, repository: { type: 'git', url: 'https://example.test/repo' },
  homepage: '', author: { name: 'fixture' }, license: 'MIT', categories: [], tags: [], examples: [],
  installations: { npm: { type: 'stdio', command: 'npx', args: ['fixture'], env: { TOKEN: 'secret-value' } } },
  arguments: { TOKEN: { required: true, description: 'Credential', example: 'secret-example' } },
  tools: [],
});

test('ranks tool-level capability matches and excludes already configured servers', () => {
  const browser = server('browser', 'Web automation');
  browser.tools = [{ name: 'screenshot', description: 'Capture browser screenshot', inputSchema: {} }];
  const configured = server('existing', 'Capture browser screenshot');
  const result = proposeMcpServers('browser screenshot', [server('db', 'SQL database'), configured, browser], ['existing']);
  expect(result.candidates.map(c => c.name)).toEqual(['browser']);
  expect(result).toMatchObject({ verification: 'catalog_only', installationPerformed: false });
  expect(result.candidates[0]).toMatchObject({ requiredInputs: ['TOKEN'], installationTypes: ['npm'] });
  expect(JSON.stringify(result)).not.toMatch(/secret-value|secret-example|"command"|"env"/);
});

test('never infers that installation is necessary and returns no unrelated candidates', () => {
  expect(proposeMcpServers('quantum', [server('db', 'SQL database')], []).candidates).toEqual([]);
  expect(proposeMcpServers('database', [server('db', 'database')], ['DB']).candidates).toEqual([]);
});

test('validates objective and limit, bounds results and deterministically resolves ties', () => {
  for (const objective of ['', '   ', 'x'.repeat(2001)]) {
    expect(() => proposeMcpServers(objective, [], [])).toThrow();
  }
  for (const limit of [0, 11, 1.5, NaN]) expect(() => proposeMcpServers('browser', [], [], limit)).toThrow();
  expect(proposeMcpServers('browser', [server('z', 'browser'), server('a', 'browser')], [], 1).candidates.map(c => c.name)).toEqual(['a']);
});
