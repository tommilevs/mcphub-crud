import { createHash } from 'node:crypto';

/** The schema byte representation must match the actual discovery fingerprint. */
export function prepareTrainingCatalogue(value: unknown) {
  try {
    if (!Array.isArray(value) || !value.length || value.length > 100 || Buffer.byteLength(JSON.stringify(value),'utf8') > 524288) return null;
    const names = new Set<string>();
    const tools = value.map(tool => {
      if (!tool || typeof tool.name !== 'string' || !tool.name || tool.name.length > 512 || names.has(tool.name) ||
        !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema) ||
        (tool.description !== undefined && typeof tool.description !== 'string')) throw new Error('Invalid catalogue');
      names.add(tool.name);
      return { name: tool.name, inputSchema: tool.inputSchema,
        ...(tool.description !== undefined ? { description: tool.description } : {}) };
    });
    return { tools, fingerprints: tools.map(tool => ({ name: tool.name,
      ...(tool.description !== undefined ? { descriptionSha256: createHash('sha256').update(tool.description).digest('hex') } : {}),
      schemaSha256: createHash('sha256').update(JSON.stringify(tool.inputSchema)).digest('hex') })) };
  } catch { return null; }
}
