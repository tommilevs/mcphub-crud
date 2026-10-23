/** Exact server/tool overrides. Invalid persisted configuration never weakens defaults. */
export function parseLoopGuardToolBudgets(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 100 || entries.some(([name, budget]) =>
    name.length > 1024 || name !== name.trim() || !/^[^\s/]+\/\S+$/.test(name) ||
    /[\u0000-\u001f]/.test(name) || typeof budget !== 'number' ||
    !Number.isSafeInteger(budget) || budget < 3 || budget > 100)) return null;
  return Object.fromEntries(entries);
}
