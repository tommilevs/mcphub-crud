import { AttributionContextService } from './attributionContextService.js';
import { withAttributionHandshake, stripAttributionInput } from './attributionHandshake.js';
import { RequestContextService } from './requestContextService.js';
import { runWithCallAttribution } from './callAttribution.js';
import { getSmartRoutingConfig } from '../utils/smartRouting.js';
import { maintainAttributionRetention } from './attributionRetention.js';

export async function runWithAttribution(request: any, handler: (request: any) => Promise<any>) {
  let config;
  try {
    config = await getSmartRoutingConfig();
  } catch {
    return runWithCallAttribution(null, () => handler(stripAttributionInput(request)));
  }
  if (config.attributionMode !== 'compatible') {
    return handler(request);
  }
  const current = RequestContextService.getInstance().getRequestContext();
  // Anonymous requests lack a stable authenticated owner for correlation keys.
  if ((!request.params?.arguments?.hub_context && !request.params?._meta?.['dev.mcphub/attribution']) || (!current?.username && !current?.keyId)) {
    return runWithCallAttribution(null, () => handler(stripAttributionInput(request)));
  }
  const principal = JSON.stringify([current.username ?? null, current.keyId ?? null]);
  try {
    const [{ getAppDataSource }, { AttributionContextRepository }] = await Promise.all([
      import('../db/connection.js'), import('../db/repositories/AttributionContextRepository.js'),
    ]);
    const repository = new AttributionContextRepository(getAppDataSource());
    maintainAttributionRetention(repository);
    const service = new AttributionContextService(repository,
      undefined, (config.attributionTtlHours ?? 168) * 60 * 60 * 1000);
    return withAttributionHandshake(request, principal, service, handler);
  } catch {
    return runWithCallAttribution(null, () => handler(stripAttributionInput(request)));
  }
}
