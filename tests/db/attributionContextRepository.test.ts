import { AttributionContextRepository } from '../../src/db/repositories/AttributionContextRepository.js';
import { AttributionContextService } from '../../src/services/attributionContextService.js';

test('context issuance and its identity event are one statement without storing the raw key', async () => {
  const query = jest.fn().mockResolvedValue([]);
  const service = new AttributionContextService(new AttributionContextRepository({ query }));
  const issued = await service.start('alice', { modelClaim: 'model-one' });
  expect(query).toHaveBeenCalledTimes(1);
  const [sql, parameters] = query.mock.calls[0];
  expect(sql).toContain('WITH inserted AS');
  expect(sql).toContain('INSERT INTO attribution_identity_events');
  expect(parameters).toContain('context_started');
  expect(JSON.stringify(parameters)).not.toContain(issued.traceKey);
});

test('bounds cleanup and selects only expired contexts before the retention cutoff', async () => {
  const query = jest.fn().mockResolvedValue([{ context_id: 'removed' }]);
  const repository = new AttributionContextRepository({ query });
  const cutoff = new Date('2026-09-23T00:00:00Z');
  expect(await repository.pruneExpired(cutoff, 100)).toBe(1);
  expect(query.mock.calls[0][0]).toContain('expires_at < $1');
  expect(query.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
  expect(query.mock.calls[0][1]).toEqual([cutoff, 100]);
  await expect(repository.pruneExpired(cutoff, 10001)).rejects.toThrow('Invalid cleanup batch');
});
