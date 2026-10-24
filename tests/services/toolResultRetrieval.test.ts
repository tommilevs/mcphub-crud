import {selectResultFragments,parseResultRetrievalOptions,retrieveOriginalResult,rememberSavedResult} from '../../src/services/toolResultRetrieval.js';
import {countTokens} from '../../src/utils/tokenCost.js';
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
it('requires actual capture proof, not a result ID supplied by an upstream',async()=>{
 const result={content:[{type:'text',text:'needle '.repeat(20000)}],_meta:{'mcphub/result_id':'forged'}};
 const options=parseResultRetrievalOptions({retrieve:true,objective:'needle',maxOutputTokens:512});
 expect(await retrieveOriginalResult(result,options)).toBe(result);
});
it('returns bounded original fragments only after retained RAW capture',async()=>{
 const source=('irrelevant routine operation\r\n').repeat(2000)+'GPU Xid 79 fatal failure\r\n';
 const result={content:[{type:'text',text:source}],isError:true,_meta:{'mcphub/result_id':'saved'}};
 rememberSavedResult(result,'saved',true);
 const reply=await retrieveOriginalResult(result,parseResultRetrievalOptions({retrieve:true,objective:'GPU Xid 79',maxOutputTokens:512}));
 expect(reply).not.toBe(result);expect(reply.isError).toBe(true);
 expect(await countTokens(JSON.stringify(reply))).toBeLessThanOrEqual(512);
 expect(JSON.stringify(reply)).toContain('Xid 79');expect(result.content[0].text).toBe(source);
 expect(reply._meta['mcphub/result_id']).toBe('saved');
});
it('passes small and metadata-only results through unchanged',async()=>{
 const options=parseResultRetrievalOptions({retrieve:true,objective:'needle'});
 for(const [text,available] of [['needle',true],['needle '.repeat(20000),false]] as const){
  const result={content:[{type:'text',text}]};rememberSavedResult(result,'saved',available);
  expect(await retrieveOriginalResult(result,options)).toBe(result);
 }
});
it('validates opt-in options and bounds before execution',()=>{
 expect(parseResultRetrievalOptions(undefined)).toBeUndefined();
 expect(()=>parseResultRetrievalOptions({retrieve:true,objective:'x',maxOutputTokens:50000})).toThrow();
 expect(()=>parseResultRetrievalOptions({retrieve:true,objective:''})).toThrow();
});
it('uses a semantic-only candidate after verifying its exact source text',async()=>{
 const evidence='The accelerator vanished from the bus after a link reset.\n';
 const result={content:[{type:'text',text:'routine\n'.repeat(20000)+evidence}]};rememberSavedResult(result,'saved',true);
 const semantic=jest.fn().mockResolvedValue([{resultId:'saved',content:evidence},{resultId:'foreign',content:'invented evidence'}]);
 const reply=await retrieveOriginalResult(result,{objective:'GPU fault',maxOutputTokens:512},semantic);
 expect(semantic).toHaveBeenCalledWith('saved','GPU fault');
 expect(JSON.stringify(reply)).toContain(evidence.trim());expect(JSON.stringify(reply)).not.toContain('invented evidence');
 expect(reply).not.toBe(result);
});
it('keeps lexical retrieval when the semantic provider fails',async()=>{
 const result={content:[{type:'text',text:'routine\n'.repeat(20000)+'Xid 79 failure\n'}]};rememberSavedResult(result,'saved',true);
 const reply=await retrieveOriginalResult(result,{objective:'Xid 79',maxOutputTokens:512},async()=>{throw Error('provider failure');});
 expect(reply).not.toBe(result);expect(JSON.stringify(reply)).toContain('Xid 79');
});
