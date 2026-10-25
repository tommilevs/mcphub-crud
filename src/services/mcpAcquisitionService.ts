import type { MarketServer } from '../types/index.js';

export class AcquisitionInputError extends Error {}

/** Read-only catalog evidence. A match does not establish installation necessity. */
export function proposeMcpServers(
  objective: string,
  catalog: readonly MarketServer[],
  configuredNames: readonly string[],
  limit = 3,
) {
  if (typeof objective !== 'string' || !objective.trim() || objective.length > 2000) {
    throw new AcquisitionInputError('objective must contain 1 to 2000 characters');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new AcquisitionInputError('limit must be an integer between 1 and 10');
  }
  const tokens = [...new Set(objective.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
  const configured = new Set(configuredNames.map(name => name.toLowerCase()));
  const candidates = catalog.filter(server => !configured.has(server.name.toLowerCase())).map(server => {
    const text = [server.name, server.display_name, server.description,
      ...(server.categories ?? []), ...(server.tags ?? []),
      ...(server.tools ?? []).flatMap(tool => [tool.name, tool.description]),
    ].join(' ').toLowerCase();
    const matchedTerms = tokens.filter(token => text.includes(token));
    return {
      name: server.name,
      displayName: server.display_name,
      description: server.description,
      provenance: { source: 'local_catalog' as const, repository: server.repository?.url ?? null },
      installationTypes: Object.keys(server.installations ?? {}).sort(),
      requiredInputs: Object.entries(server.arguments ?? {})
        .filter(([, argument]) => argument.required).map(([name]) => name).sort(),
      matchedTerms,
      score: tokens.length ? matchedTerms.length / tokens.length : 0,
    };
  }).filter(candidate => candidate.score > 0 && candidate.installationTypes.length > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
  return { verification: 'catalog_only' as const, installationPerformed: false as const, candidates };
}
