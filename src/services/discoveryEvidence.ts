import { createHash } from 'node:crypto';

export interface DiscoveryEvidence {
  operation: 'search_tools' | 'describe_tool';
  candidates: Array<{ name: string; schemaSha256: string | null; descriptionSha256?: string }>;
  truncated: boolean;
}

/** Fingerprints only: never retain query text, descriptions or schema defaults. */
export function extractDiscoveryEvidence(operation: string, result: any): DiscoveryEvidence | null {
  if (!['search_tools', 'describe_tool'].includes(operation) || result?.isError) return null;
  const text = result?.content?.find((block: any) => block?.type === 'text')?.text;
  if (typeof text !== 'string' || text.length > 2_000_000) return null;
  try {
    const data = JSON.parse(text);
    const tools = operation === 'search_tools' ? data.tools : data.tool ? [data.tool] : null;
    if (!Array.isArray(tools)) return null;
    const candidates = tools.slice(0, 100).filter((tool) => typeof tool?.name === 'string' && tool.name.length <= 512)
      .map((tool) => ({ name: tool.name,
        ...(typeof tool.description === 'string' ? { descriptionSha256: createHash('sha256').update(tool.description).digest('hex') } : {}),
        schemaSha256: tool.inputSchema && typeof tool.inputSchema === 'object'
        ? createHash('sha256').update(JSON.stringify(tool.inputSchema)).digest('hex') : null }));
    return { operation: operation as DiscoveryEvidence['operation'], candidates,
      truncated: tools.length > 100 || candidates.length !== tools.length };
  } catch { return null; }
}
