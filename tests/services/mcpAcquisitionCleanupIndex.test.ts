import {withCleanupIndexGuard} from '../../src/services/mcpAcquisitionCleanupIndex.js';
const fixture=(relation:unknown='vector_embeddings',referenced:unknown=false)=>{
  const query=jest.fn(async(sql:string)=>sql.includes('to_regclass')?[{relation}]:sql.startsWith('LOCK')?[]:[{referenced}]);
  return {query,db:{transaction:jest.fn(async(_isolation:unknown,work:any)=>work({query}))}};
};
test('holds a write-excluding index lock through asynchronous work',async()=>{
  const {db,query}=fixture();
  await withCleanupIndexGuard(db as any,['fixture'],async()=>{
    expect(query.mock.calls.some(([sql])=>sql==='LOCK TABLE vector_embeddings IN SHARE ROW EXCLUSIVE MODE')).toBe(true);
    await Promise.resolve();return 'done';
  });
  expect(db.transaction).toHaveBeenCalledWith('SERIALIZABLE',expect.any(Function));
});
test.each([[null,false],['vector_embeddings',true],['vector_embeddings',null]])('refuses absent, referenced, or unknown indexes',async(relation,referenced)=>{
  const {db}=fixture(relation,referenced);const work=jest.fn();
  await expect(withCleanupIndexGuard(db as any,['fixture'],work)).rejects.toThrow();expect(work).not.toHaveBeenCalled();
});
test('does not reinterpret a failure in guarded work as successful cleanup',async()=>{
  const {db}=fixture();const failure=Error('native outcome unknown');
  await expect(withCleanupIndexGuard(db as any,['fixture'],async()=>{throw failure;})).rejects.toBe(failure);
});
