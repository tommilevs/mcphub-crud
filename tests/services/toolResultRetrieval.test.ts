import {selectResultFragments} from '../../src/services/toolResultRetrieval.js';
it('finds exact diagnostic identifiers late in a large result and preserves original bytes',()=>{
 const text=('routine operation completed\r\n').repeat(1200)+'GPU 2: Xid 79, PCIe link lost\r\n';
 const fragments=selectResultFragments(text,'Find Xid 79 on GPU 2',1000);
 expect(fragments.some(fragment=>fragment.text.includes('Xid 79'))).toBe(true);
 for(const fragment of fragments)expect(text.slice(fragment.start,fragment.end)).toBe(fragment.text);
 expect(fragments.reduce((sum,fragment)=>sum+fragment.text.length,0)).toBeLessThanOrEqual(1000);
});
it('scores a rare exact path above repetitive unrelated matches and returns source order',()=>{
 const text=('failed request on /other/path\n').repeat(100)+'ERROR /srv/config.json ENOENT\n'+('normal\n').repeat(100);
 const hits=selectResultFragments(text,'/srv/config.json ENOENT',600);
 expect(hits.some(hit=>hit.text.includes('/srv/config.json ENOENT'))).toBe(true);
 expect(hits.map(hit=>hit.start)).toEqual([...hits.map(hit=>hit.start)].sort((a,b)=>a-b));
});
it('does not manufacture evidence when the objective has no match',()=>{
 expect(selectResultFragments('healthy status\n','NCCL timeout',100)).toEqual([]);
});
it('never splits a Unicode surrogate pair to meet a fragment boundary',()=>{
 const text='needle '+('😀'.repeat(1000));
 for(const hit of selectResultFragments(text,'needle',101)){
  expect(hit.text).toBe(text.slice(hit.start,hit.end));
  expect(hit.text).not.toMatch(/[\uD800-\uDBFF]$/);
 }
});
