import type { AttributionContextRepository } from '../db/repositories/AttributionContextRepository.js';

let nextAttemptAt = 0;
let running = false;

/** Opportunistic bounded maintenance; no timer/process survives shutdown. */
export function maintainAttributionRetention(repository: Pick<AttributionContextRepository, 'pruneExpired'>): void {
  const now = Date.now();
  if (running || now < nextAttemptAt) return;
  const configured = Number(process.env.MCPHUB_ATTRIBUTION_RETENTION_DAYS ?? 30);
  const days = Number.isInteger(configured) && configured >= 1 && configured <= 3650 ? configured : 30;
  running = true;
  nextAttemptAt = now + 60 * 60 * 1000;
  void repository.pruneExpired(new Date(now - days * 24 * 60 * 60 * 1000), 500)
    .catch(() => { nextAttemptAt = Date.now() + 5 * 60 * 1000; })
    .finally(() => { running = false; });
}
