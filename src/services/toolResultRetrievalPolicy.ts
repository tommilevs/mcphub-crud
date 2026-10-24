import type {ResultRetrievalOptions} from './toolResultRetrieval.js';
import {getCachedSystemConfig} from '../utils/systemConfigCache.js';
import {getSystemConfigDao} from '../dao/DaoFactory.js';
export interface ResultRetrievalPolicy {mode?:'passthrough'|'fragments';minTokens?:number;maxOutputTokens?:number;}
export interface ResultRetrievalConfig extends ResultRetrievalPolicy {policies?:Record<string,ResultRetrievalPolicy>;}
export function parseResultRetrievalPolicy(value:unknown):ResultRetrievalConfig{
 const parse=(input:unknown,root:boolean):ResultRetrievalConfig=>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid result retrieval policy');
  const data=input as Record<string,unknown>,out:ResultRetrievalConfig={};
  for(const [key,item] of Object.entries(data)){
   if(key==='mode'&&(item==='passthrough'||item==='fragments'))out.mode=item;
   else if(key==='minTokens'&&typeof item==='number'&&Number.isSafeInteger(item)&&item>=512&&item<=1000000)out.minTokens=item;
   else if(key==='maxOutputTokens'&&typeof item==='number'&&Number.isInteger(item)&&item>=512&&item<=4096)out.maxOutputTokens=item;
   else if(key==='policies'&&root&&item&&typeof item==='object'&&!Array.isArray(item)){
    const entries=Object.entries(item);
    if(entries.length>1000||entries.some(([name])=>!name||name.length>512))throw Error('Invalid result retrieval policy keys');
    out.policies=Object.fromEntries(entries.map(([name,rule])=>[name,parse(rule,false)]));
   }else throw Error('Invalid result retrieval policy field or bound');
  }
  return out;
 };
 return parse(value,true);
}
export function resolveResultRetrievalPolicy(options:ResultRetrievalOptions,config:ResultRetrievalConfig,server:string,tool:string):ResultRetrievalOptions|undefined{
 const policies=config.policies??{};
 const rule:ResultRetrievalPolicy={mode:'fragments',minTokens:8000,maxOutputTokens:4096,...config};
 for(const key of [`${server}/*`,tool,`${server}/${tool}`])if(Object.prototype.hasOwnProperty.call(policies,key))Object.assign(rule,policies[key]);
 if(rule.mode==='passthrough')return undefined;
 return {...options,minTokens:rule.minTokens,maxOutputTokens:Math.min(options.maxOutputTokens,rule.maxOutputTokens!)};
}
export async function configuredResultRetrievalOptions(options:ResultRetrievalOptions,server:string,tool:string):Promise<ResultRetrievalOptions|undefined>{
 try{
  const settings=getCachedSystemConfig()??await getSystemConfigDao().get();
  return resolveResultRetrievalPolicy(options,parseResultRetrievalPolicy(settings?.smartRouting?.resultRetrieval??{}),server,tool);
 }catch{return undefined;} // Unknown policy must preserve the full response.
}
