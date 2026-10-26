import {createHash} from 'node:crypto';
import {assertNoCleanupReferences,type CleanupReferenceServer,type CleanupReferenceTarget} from './mcpAcquisitionCleanupReferences.js';

export interface RuntimeCleanupLease {
  retire(close:()=>void|Promise<void>,confirmed:()=>boolean):Promise<void>;
  unconfirmed():void;
}

/** Internal launch snapshots only; never expose resolved credentials in an API.
 * Unknown outcomes remain references. Repeated identical failures are compacted
 * without letting a later successful stop erase an earlier uncertain process. */
export class RuntimeCleanupTracker {
  private references=new Map<symbol,CleanupReferenceServer>();
  private uncertain=new Map<string,CleanupReferenceServer>();
  private cleanupActive=false;
  private revision=0;
  get generation():number{return this.revision;}

  begin(name:string,config:unknown,generation:number):RuntimeCleanupLease {
    if(this.cleanupActive)throw new Error('Runtime cleanup is in progress; retry');
    if(generation!==this.revision)throw new Error('Runtime cleanup state changed; retry');
    const key=Symbol(),entry={name,config:structuredClone(config)};
    this.references.set(key,entry);
    const unconfirmed=()=>{
      if(!this.references.delete(key))return;
      const identity=createHash('sha256').update(JSON.stringify(entry)).digest('hex');
      this.uncertain.set(identity,entry);
    };
    let closing:Promise<void>|undefined;
    return {unconfirmed,retire:(close,confirmed)=>closing??=(async()=>{
      try{
        await close();
        if(confirmed())this.references.delete(key);else unconfirmed();
      }catch(error){unconfirmed();throw error;}
    })()};
  }

  async withCleanupGuard<T>(target:CleanupReferenceTarget,work:()=>Promise<T>,
    resolvePath?:(path:string)=>Promise<string>):Promise<T>{
    if(this.cleanupActive)throw new Error('Runtime cleanup is already in progress');
    this.cleanupActive=true;this.revision++;
    try{
      await assertNoCleanupReferences([...this.references.values(),...this.uncertain.values()],target,resolvePath);
      return await work();
    }finally{this.cleanupActive=false;}
  }
}
