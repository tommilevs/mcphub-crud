/**
 * MCP-Zero-style hierarchical discovery primitives.
 *
 * This stays provider-agnostic: callers supply already-indexed server and tool
 * candidates, so no Python process, extra embedding request, or second index is
 * required. It is deliberately separate from smartRoutingService so later
 * objective/result-history signals can join the ranking without changing the
 * public Smart Routing API.
 */
export interface McpZeroToolCandidate<T> {
  candidate: T;
  serverRank: number;
  serverScore: number;
  toolRank: number;
  toolScore: number;
}

export interface RoutingDiagnostics {
  baseline?: { rank: number; score: number };
  mcpZero?: {
    serverRank: number;
    serverScore: number;
    toolRank: number;
    toolScore: number;
  };
  fusion: { strategy: 'rrf'; score: number; rank: number };
}

export type RoutingCandidate = {
  serverName: string;
  toolName: string;
  similarity: number;
  routingDiagnostics?: RoutingDiagnostics;
};

const identityFor = (candidate: Pick<RoutingCandidate, 'serverName' | 'toolName'>): string =>
  `${candidate.serverName}\u0000${candidate.toolName}`;

export const rankMcpZeroServers = (serverScores: Map<string, number>, topServers: number): string[] =>
  [...serverScores.entries()]
    .sort(([, left], [, right]) => right - left)
    .slice(0, Math.max(1, topServers))
    .map(([serverName]) => serverName);

export const scoreMcpZeroCandidate = (serverScore: number, toolScore: number): number =>
  serverScore * toolScore * Math.max(serverScore, toolScore);

/**
 * Reciprocal Rank Fusion avoids mixing incomparable cosine-score distributions.
 * The baseline is always retained, so an incomplete server shortlist cannot hide
 * a valid tool.
 */
export const fuseMcpZeroCandidates = <T extends RoutingCandidate>(
  baseline: T[],
  mcpZero: Array<McpZeroToolCandidate<T>>,
  limit: number,
  rrfConstant: number = 60,
): Array<T & { routingDiagnostics: RoutingDiagnostics }> => {
  const fused = new Map<
    string,
    { candidate: T; score: number; baseline?: { rank: number; score: number }; mcpZero?: McpZeroToolCandidate<T> }
  >();
  const add = (candidate: T, rank: number, source: 'baseline' | 'mcpZero', zero?: McpZeroToolCandidate<T>) => {
    const key = identityFor(candidate);
    const existing = fused.get(key) ?? { candidate, score: 0 };
    existing.score += 1 / (rrfConstant + rank);
    if (source === 'baseline') {
      existing.baseline = { rank, score: candidate.similarity };
    } else if (zero) {
      existing.mcpZero = zero;
    }
    fused.set(key, existing);
  };

  const baselineSeen = new Set<string>();
  baseline.forEach(candidate => {
    const key = identityFor(candidate);
    if (baselineSeen.has(key)) return;
    baselineSeen.add(key);
    add(candidate, baselineSeen.size, 'baseline');
  });
  const mcpZeroSeen = new Set<string>();
  mcpZero.forEach(entry => {
    const key = identityFor(entry.candidate);
    if (mcpZeroSeen.has(key)) return;
    mcpZeroSeen.add(key);
    add(entry.candidate, mcpZeroSeen.size, 'mcpZero', entry);
  });

  return [...fused.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry, index) => ({
      ...entry.candidate,
      similarity: entry.score,
      routingDiagnostics: {
        ...(entry.baseline ? { baseline: entry.baseline } : {}),
        ...(entry.mcpZero
          ? {
              mcpZero: {
                serverRank: entry.mcpZero.serverRank,
                serverScore: entry.mcpZero.serverScore,
                toolRank: entry.mcpZero.toolRank,
                toolScore: entry.mcpZero.toolScore,
              },
            }
          : {}),
        fusion: { strategy: 'rrf', score: entry.score, rank: index + 1 },
      },
    }));
};
