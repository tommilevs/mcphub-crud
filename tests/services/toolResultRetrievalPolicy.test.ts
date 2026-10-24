import {parseResultRetrievalPolicy,resolveResultRetrievalPolicy} from '../../src/services/toolResultRetrievalPolicy.js';
const options={objective:'needle',maxOutputTokens:3000};
it('lets a protected tool override caller opt-in and server defaults',()=>{
 const policy=parseResultRetrievalPolicy({minTokens:12000,policies:{'memory/*':{mode:'fragments'},'memory/read_content':{mode:'passthrough'}}});
 expect(resolveResultRetrievalPolicy(options,policy,'memory','read_content')).toBeUndefined();
});
it('applies global, server and tool precedence while capping a requested budget',()=>{
 const policy=parseResultRetrievalPolicy({minTokens:9000,maxOutputTokens:2000,policies:{'srv/*':{minTokens:10000},'read':{maxOutputTokens:1500},'srv/read':{minTokens:12000}}});
 expect(resolveResultRetrievalPolicy(options,policy,'srv','read')).toEqual({objective:'needle',minTokens:12000,maxOutputTokens:1500});
 expect(resolveResultRetrievalPolicy({...options,maxOutputTokens:512},policy,'srv','read')?.maxOutputTokens).toBe(512);
});
it.each([{minTokens:0},{maxOutputTokens:50000},{policies:[]},{policies:{x:{mode:'summary'}}}])('rejects malformed policies rather than silently weakening them',value=>{
 expect(()=>parseResultRetrievalPolicy(value)).toThrow();
});
