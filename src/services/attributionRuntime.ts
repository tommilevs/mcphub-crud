import { AttributionContextService } from './attributionContextService.js';
import { withAttributionHandshake } from './attributionHandshake.js';
import { RequestContextService } from './requestContextService.js';
import { runWithCallAttribution } from './callAttribution.js';

export async function runWithAttribution(request: any, handler: (request: any) => Promise<any>) {
  if (process.env.MCPHUB_ATTRIBUTION_MODE !== 'compatible') {
    return handler(request);
  }
  const current = RequestContextService.getInstance().getRequestContext();
  // Anonymous requests lack a stable authenticated owner for correlation keys.
  if ((!request.params?.arguments?.hub_context && !request.params?._meta?.['dev.mcphub/attribution']) || (!current?.username && !current?.keyId)) {
    return runWithCallAttribution(null, () => handler(request));
  }
  const principal = JSON.stringify([current.username ?? null, current.keyId ?? null]);
  try {
    const [{ getAppDataSource }, { AttributionContextRepository }] = await Promise.all([
      import('../db/connection.js'), import('../db/repositories/AttributionContextRepository.js'),
    ]);
    const service = new AttributionContextService(new AttributionContextRepository(getAppDataSource()));
    return withAttributionHandshake(request, principal, service, handler);
  } catch {
    return runWithCallAttribution(null, () => handler(request));
  }
}
