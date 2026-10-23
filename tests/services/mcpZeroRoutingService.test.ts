import {
  fuseMcpZeroCandidates,
  rankMcpZeroServers,
  scoreMcpZeroCandidate,
} from '../../src/services/mcpZeroRoutingService.js';

describe('mcpZeroRoutingService', () => {
  it('ranks server candidates and applies the MCP-Zero score formula', () => {
    expect(rankMcpZeroServers(new Map([['mail', 0.4], ['maps', 0.9]]), 1)).toEqual(['maps']);
    expect(scoreMcpZeroCandidate(0.9, 0.7)).toBeCloseTo(0.567);
  });

  it('uses RRF to promote a tool found by both baseline and MCP-Zero without duplicates', () => {
    const baseline = [
      { serverName: 'mail', toolName: 'send', similarity: 0.99 },
      { serverName: 'maps', toolName: 'route', similarity: 0.7 },
    ];
    const mcpZero = [
      {
        candidate: baseline[1],
        serverRank: 1,
        serverScore: 0.9,
        toolRank: 1,
        toolScore: 0.7,
      },
    ];

    const fused = fuseMcpZeroCandidates(baseline, mcpZero, 10);

    expect(fused.map((candidate) => candidate.toolName)).toEqual(['route', 'send']);
    expect(fused).toHaveLength(2);
    expect(fused[0].routingDiagnostics).toMatchObject({
      baseline: { rank: 2, score: 0.7 },
      mcpZero: { serverRank: 1, toolRank: 1, serverScore: 0.9, toolScore: 0.7 },
    });
  });
});
