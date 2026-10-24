import {countTokens} from '../utils/tokenCost.js';
import {originalResultWindows} from './originalResultWindows.js';
export interface OriginalResultFragment {start:number;end:number;text:string;score:number;}
export interface ResultRetrievalOptions {objective:string;maxOutputTokens:number;minTokens?:number;}
const savedResults=new WeakMap<object,{resultId:string;payloadAvailable:boolean}>();
/** In-process capture proof. Upstream JSON cannot manufacture this association. */
export function rememberSavedResult(result:object,resultId:string,payloadAvailable:boolean){savedResults.set(result,{resultId,payloadAvailable});}
export function parseResultRetrievalOptions(value:unknown,fallbackObjective?:unknown):ResultRetrievalOptions|undefined{
 if(value===undefined)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid smart result settings');
 const settings=value as Record<string,unknown>;
 if(Object.keys(settings).some(key=>!['retrieve','objective','maxOutputTokens'].includes(key))||typeof settings.retrieve!=='boolean')throw Error('Invalid smart result settings');
 if(!settings.retrieve)return undefined;
 const objective=settings.objective??fallbackObjective;
 const budget=settings.maxOutputTokens??3000;
 if(typeof objective!=='string'||!objective.trim()||objective.length>2000||typeof budget!=='number'||!Number.isInteger(budget)||budget<512||budget>4096)throw Error('Smart retrieval requires an objective (1–2000 characters) and token budget 512–4096');
 return {objective:objective.trim(),maxOutputTokens:budget};
}
export type SemanticResultCandidates=(resultId:string,objective:string)=>Promise<Array<{resultId:string;content:string}>>;
export async function retrieveOriginalResult<T extends Record<string,any>>(result:T,options?:ResultRetrievalOptions,semantic?:SemanticResultCandidates):Promise<T>{
 const saved=savedResults.get(result);
 if(!options||!saved?.payloadAvailable||!Array.isArray(result.content))return result;
 try{
  if(await countTokens(JSON.stringify(result))<=(options.minTokens??8000))return result;
  const fragments:Array<OriginalResultFragment&{block:number}>=[];
  result.content.forEach((block:any,index:number)=>{
   if(block?.type==='text'&&typeof block.text==='string')fragments.push(...selectResultFragments(block.text,options.objective,options.maxOutputTokens*2).map(hit=>({...hit,block:index})));
  });
  fragments.sort((a,b)=>b.score-a.score||a.block-b.block||a.start-b.start);
  let hybrid=false;
  if(semantic){
   const candidates=await semantic(saved.resultId,options.objective).catch(()=>[]);
   const semanticFragments:Array<OriginalResultFragment&{block:number}>=[];
   for(const hit of candidates){
    if(hit.resultId!==saved.resultId||!hit.content)continue;
    result.content.forEach((block:any,index:number)=>{
     if(block?.type!=='text'||typeof block.text!=='string')return;
     let content=hit.content,start=block.text.indexOf(content);
     if(start<0){
      // The first indexed chunk can contain server/tool/objective metadata.
      const prefix=content.indexOf(block.text.slice(0,128));
      if(prefix<0)return;
      content=content.slice(prefix);if(!block.text.startsWith(content))return;start=0;
     }
     semanticFragments.push({block:index,start,end:start+content.length,text:content,score:0});
    });
   }
   if(semanticFragments.length){
    hybrid=true;
    const fused=new Map<string,OriginalResultFragment&{block:number}>();
    for(const source of [fragments,semanticFragments]){
     const seen=new Set<string>();let rank=0;
     for(const fragment of source){
      const key=`${fragment.block}:${fragment.start}:${fragment.end}`;
      if(seen.has(key))continue;seen.add(key);rank++;
      const previous=fused.get(key);fused.set(key,{...fragment,score:(previous?.score??0)+1/(60+rank)});
     }
    }
    fragments.splice(0,fragments.length,...[...fused.values()].sort((a,b)=>b.score-a.score));
   }
  }
  if(!fragments.length)return result;
  const selected:typeof fragments=[];
  for(const fragment of fragments)if(!selected.some(hit=>hit.block===fragment.block&&hit.start<fragment.end&&fragment.start<hit.end))selected.push(fragment);
  fragments.splice(0,fragments.length,...selected);
  const makeReply=()=>({
   content:[{type:'text',text:JSON.stringify({representation:'original-fragments',result_id:saved.resultId,offset_units:'UTF-16 code units; end exclusive',fragments:[...fragments].sort((a,b)=>a.block-b.block||a.start-b.start).map(({score:_score,...hit})=>hit),full_result_tool:'get_tool_result'})}],
   ...(result.isError!==undefined?{isError:result.isError}:{}),
   _meta:{...result._meta,'mcphub/result_id':saved.resultId,'dev.mcphub/retrieval':{algorithm:hybrid?'bm25-vector-rrf':'bm25-exact',partial:true,maxOutputTokens:options.maxOutputTokens}},
  });
  while(fragments.length){const reply=makeReply();if(await countTokens(JSON.stringify(reply))<=options.maxOutputTokens)return reply as unknown as T;fragments.pop();}
 }catch{/* Retrieval failure must not lose the original successful tool response. */}
 return result;
}
const tokens=(text:string)=>text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_]+(?:[./:\\-][\p{L}\p{N}_]+)*/gu)??[];

/** BM25 over bounded original windows. Offsets are end-exclusive UTF-16 indices.
 * This lexical candidate layer does not summarize or mutate source evidence.
 */
export function selectResultFragments(text:string,objective:string,maxChars:number):OriginalResultFragment[]{
 if(!Number.isSafeInteger(maxChars)||maxChars<2)throw new RangeError('Fragment budget must be an integer of at least two characters');
 const terms=[...new Set(tokens(objective))];
 if(!terms.length||!text)return [];
 const chunks:Array<OriginalResultFragment&{terms:Map<string,number>;length:number}>=[];
 const frequencies=new Map<string,number>();
 const width=Math.min(1200,maxChars);
 for(const {start,end,text:content} of originalResultWindows(text,width)){
  const words=tokens(content),counts=new Map<string,number>();
  for(const word of words)counts.set(word,(counts.get(word)??0)+1);
  for(const term of terms)if(counts.has(term))frequencies.set(term,(frequencies.get(term)??0)+1);
  chunks.push({start,end,text:content,score:0,terms:counts,length:words.length});
 }
 const average=chunks.reduce((sum,chunk)=>sum+chunk.length,0)/chunks.length||1;
 for(const chunk of chunks){
  for(const term of terms){
   const tf=chunk.terms.get(term)??0;if(!tf)continue;
   const df=frequencies.get(term)??0;
   const idf=Math.log(1+(chunks.length-df+0.5)/(df+0.5));
   chunk.score+=idf*(tf*2.2)/(tf+1.2*(0.25+0.75*chunk.length/average));
  }
  if(chunk.score&&/\b(?:ERROR|FATAL|XID|ENOMEM|SIGSEGV|OOM|NCCL|CUDA|errno)\b/i.test(chunk.text))chunk.score*=1.15;
 }
 const selected:OriginalResultFragment[]=[];let remaining=maxChars;
 for(const chunk of chunks.sort((a,b)=>b.score-a.score||a.start-b.start)){
  if(chunk.score<=0||chunk.text.length>remaining)continue;
  selected.push({start:chunk.start,end:chunk.end,text:chunk.text,score:chunk.score});remaining-=chunk.text.length;
 }
 return selected.sort((a,b)=>a.start-b.start);
}
