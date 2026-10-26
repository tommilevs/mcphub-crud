import type {AcquisitionCleanupJournal} from './mcpAcquisitionCleanupJournal.js';
import {acquisitionManifestDigest, type AcquisitionManifest} from './mcpAcquisitionPlan.js';
import {acquisitionSecretId} from './mcpAcquisitionSecretIdentity.js';
import {assertNoCleanupReferences, type CleanupReferenceTarget} from './mcpAcquisitionCleanupReferences.js';

interface NativeIdentity {readonly id:string;readonly package:string;readonly version:string}
type Guard<T> = (identity:T,work:()=>Promise<void>)=>Promise<void>;
export interface AcquisitionCleanupDependencies {
  journal:Pick<AcquisitionCleanupJournal,'claim'|'get'|'recordStep'|'recordSecret'|'requireReview'>;
  inspect(identity:NativeIdentity):Promise<unknown>;
  drain():Promise<void>;
  withSettings:Guard<CleanupReferenceTarget>;
  withRuntime:Guard<CleanupReferenceTarget>;
  withIndex:Guard<readonly string[]>;
  /** Must reserve both machine and interactive native supervisors. */
  withNative:Guard<NativeIdentity>;
  removePackage(identity:NativeIdentity):Promise<unknown>;
  deleteSecret(id:string):Promise<unknown>;
}

/** Internal coordinator. No production adapter or public endpoint is enabled
 * until native deletion and cross-session reservations have acceptance evidence.
 * Native effects accept derived identities, never a caller-supplied path. */
export async function runAcquisitionCleanup(owner:string,id:string,deps:AcquisitionCleanupDependencies){
  const claim=await deps.journal.claim(owner,id);
  if(!claim)return {status:'not_claimed' as const,cleanup:await deps.journal.get(owner,id)};
  const token=claim.cleanup_claim_id;
  let reviewCode:'ownership_unconfirmed'|'cleanup_outcome_unknown'='ownership_unconfirmed';
  try{
    const manifest:AcquisitionManifest=structuredClone(claim.manifest);
    if(acquisitionManifestDigest(manifest)!==claim.manifest_digest||manifest.schemaVersion!==1||
      manifest.transport!=='stdio'||manifest.package?.ecosystem!=='npm'||
      typeof manifest.serverName!=='string'||!manifest.serverName.trim()||manifest.serverName.length>255||
      !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.package.name)||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.package.version)||
      !Array.isArray(manifest.requiredInputs)||manifest.requiredInputs.length>64||
      new Set(manifest.requiredInputs).size!==manifest.requiredInputs.length||
      manifest.requiredInputs.some(name=>typeof name!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)||
        ['__proto__','constructor','prototype'].includes(name)))throw new Error('Invalid cleanup manifest');
    const identity=Object.freeze({id,package:manifest.package.name,version:manifest.package.version});
    const inspection:any=await deps.inspect(identity);
    if(inspection?.id!==id||inspection?.verification!=='cleanup_preflight'||inspection.processExitConfirmed!==true||typeof inspection.directory!=='string')
      throw new Error('Unconfirmed cleanup identity');
    const target:CleanupReferenceTarget={operationId:id,directory:inspection.directory,
      secretIds:manifest.requiredInputs.map(name=>acquisitionSecretId(owner,id,name))};
    await assertNoCleanupReferences([],target);
    // Drain before acquiring settings/index locks: queued writes may need them.
    await deps.drain();
    await deps.withSettings(target,()=>deps.withRuntime(target,()=>deps.withIndex([manifest.serverName],()=>
      deps.withNative(identity,async()=>{
        reviewCode='cleanup_outcome_unknown';
        const receipt:any=await deps.removePackage(identity);
        if(receipt?.id!==id||receipt.package!==identity.package||receipt.version!==identity.version||
          receipt.verification!=='cleanup_complete')throw new Error('Unconfirmed file deletion');
        if(!await deps.journal.recordStep(owner,id,token,'files'))throw new Error('Cleanup claim lost');
        for(const name of manifest.requiredInputs){
          const response:any=await deps.deleteSecret(acquisitionSecretId(owner,id,name));
          if(response?.ok!==true)throw new Error('Unconfirmed credential deletion');
          if(!await deps.journal.recordSecret(owner,id,token,name))throw new Error('Cleanup claim lost');
        }
      }))));
    // Do not report completion if releasing any reservation failed.
    if(!await deps.journal.recordStep(owner,id,token,'secrets'))throw new Error('Cleanup claim lost');
    return {status:'complete' as const};
  }catch{
    let checkpointSaved=false;
    try{checkpointSaved=await deps.journal.requireReview(owner,id,token,reviewCode);}catch{/* claim still fences replay */}
    return {status:'review_required' as const,checkpointSaved};
  }
}
