import {RuntimeCleanupTracker} from '../../src/services/runtimeCleanupTracker.js';
const id='00000000-0000-4000-8000-000000000001';
const target={operationId:id,directory:`C:\\data\\acquisitions\\${id}`,secretIds:[]};
const absent=async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});};
const config=()=>({command:'node.exe',args:[`${target.directory}\\entry.js`]});

test('pending starts and unconfirmed closes retain their original launch references',async()=>{
 const tracker=new RuntimeCleanupTracker(),source=config();
 const lease=tracker.begin('renamed',source,tracker.generation);source.args=[];
 const work=jest.fn();
 await expect(tracker.withCleanupGuard(target,work,absent)).rejects.toThrow('references');
 await lease.retire(async()=>undefined,()=>false);
 await expect(tracker.withCleanupGuard(target,work,absent)).rejects.toThrow('references');
 expect(work).not.toHaveBeenCalled();
});
test('only confirmed shutdown releases a reference and concurrent retire calls coalesce',async()=>{
 const tracker=new RuntimeCleanupTracker(),lease=tracker.begin('fixture',config(),tracker.generation);
 let finish!:()=>void;const close=jest.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const first=lease.retire(close,()=>true),second=lease.retire(close,()=>true);
 await expect(tracker.withCleanupGuard(target,async()=>undefined,absent)).rejects.toThrow('references');
 finish();await Promise.all([first,second]);expect(close).toHaveBeenCalledTimes(1);
 await expect(tracker.withCleanupGuard(target,async()=>'done',absent)).resolves.toBe('done');
});
test('cleanup blocks new starts and invalidates preparations that began before it',async()=>{
 const tracker=new RuntimeCleanupTracker(),generation=tracker.generation;
 await tracker.withCleanupGuard(target,async()=>{
  expect(()=>tracker.begin('late',config(),tracker.generation)).toThrow('cleanup');
 },absent);
 expect(()=>tracker.begin('stale',config(),generation)).toThrow('changed');
 const lease=tracker.begin('fresh',config(),tracker.generation);
 await lease.retire(async()=>undefined,()=>true);
});
test('failed close and failed connection never prove absence',async()=>{
 const tracker=new RuntimeCleanupTracker(),lease=tracker.begin('fixture',config(),tracker.generation);
 const failure=Error('stop unavailable');
 await expect(lease.retire(async()=>{throw failure;},()=>true)).rejects.toBe(failure);
 await expect(tracker.withCleanupGuard(target,async()=>undefined,absent)).rejects.toThrow('references');
 const other=new RuntimeCleanupTracker();other.begin('pending',config(),other.generation).unconfirmed();
 await expect(other.withCleanupGuard(target,async()=>undefined,absent)).rejects.toThrow('references');
});
test('a later confirmed stop cannot erase an earlier uncertain launch of the same definition',async()=>{
 const tracker=new RuntimeCleanupTracker();tracker.begin('fixture',config(),tracker.generation).unconfirmed();
 await tracker.begin('fixture',config(),tracker.generation).retire(async()=>undefined,()=>true);
 await expect(tracker.withCleanupGuard(target,async()=>undefined,absent)).rejects.toThrow('references');
});
