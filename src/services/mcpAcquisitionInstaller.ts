import { getAppDataSource } from '../db/connection.js';
import { AcquisitionOperationRepository } from './mcpAcquisitionOperation.js';
import { startNativeNpmInstall, getNativeInstallStatus, cancelNativeInstall } from './nativeRuntimeSecretService.js';

type Status = { state?: unknown; exitCode?: unknown };
interface InstallerDependencies {
  repository: Pick<AcquisitionOperationRepository, 'get' | 'claim' | 'transition' | 'requireReconciliation'>;
  native: { start(id: string, name: string, version: string): Promise<Status>;
    status(id: string): Promise<Status>; cancel(id: string): Promise<unknown> };
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Installation phase only. A staged package is not a verified or published MCP server. */
export async function stageAcquisitionPackage(owner: string, operationId: string, overrides?: InstallerDependencies) {
  const dependencies: InstallerDependencies = overrides ?? {
    repository: new AcquisitionOperationRepository(getAppDataSource()),
    native: {
      start: async (id, name, version) => {
        const result = await startNativeNpmInstall(id, name, version);
        return { state: result.state, exitCode: result.exitCode };
      },
      status: async id => {
        const result = await getNativeInstallStatus(id);
        return { state: result.state, exitCode: result.exitCode };
      },
      cancel: cancelNativeInstall,
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now,
  };
  const { repository, native, sleep, now } = dependencies;
  const claim = await repository.claim(owner, operationId);
  if (!claim) return { status: 'not_claimed' as const };
  const reconcile = async () => {
    let checkpointSaved = false;
    try { checkpointSaved = await repository.requireReconciliation(owner, operationId, claim.claim_id); } catch { /* claim remains held */ }
    return { status: 'reconciliation_required' as const, checkpointSaved };
  };
  const fail = async (reason: string) => {
    const updated = await repository.transition(owner, operationId, claim.claim_id, 'staging', 'failed', reason);
    return updated ? { status: 'failed' as const, reason } : reconcile();
  };
  try {
    let operation = await repository.get(owner, operationId);
    if (!operation || operation.requires_reconciliation) return reconcile();
    if (operation.cancel_requested) {
      // No native action has been attempted, so there is no staging to clean.
      const updated = await repository.transition(owner, operationId, claim.claim_id, 'staging', 'rolled_back');
      return updated ? { status: 'cancelled' as const } : reconcile();
    }
    const deadline = now() + 930_000;
    let status = await native.start(operationId, claim.manifest.package.name, claim.manifest.package.version);
    let cancelSent = false;
    for (let polls = 0; polls < 465; polls++) {
      operation = await repository.get(owner, operationId);
      if (!operation || operation.requires_reconciliation) return reconcile();
      if (operation.cancel_requested && status.state === 'running' && !cancelSent) {
        await native.cancel(operationId); cancelSent = true;
      }
      if (status.state === 'exited' || ['failed', 'cancelled', 'timed_out'].includes(String(status.state))) {
        if (operation.cancel_requested || status.state === 'cancelled') return await fail('cancelled_requires_cleanup');
        if (status.state !== 'exited' || status.exitCode !== 0) return await fail('installer_failed');
        const updated = await repository.transition(owner, operationId, claim.claim_id, 'staging', 'starting');
        // A cancellation racing this transition must not start an MCP process.
        return updated ? { status: 'package_staged' as const } : await fail('cancelled_requires_cleanup');
      }
      if (status.state !== 'running' || now() >= deadline) return reconcile();
      await sleep(2000);
      status = await native.status(operationId);
    }
    return reconcile();
  } catch {
    // A transport failure does not prove whether a native side effect occurred.
    // Never retry start or delete staging on an unknown outcome.
    return reconcile();
  }
}
