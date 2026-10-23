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
