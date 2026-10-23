import {createHash,randomUUID} from 'node:crypto';
import {buildDataset,refreshDatasetManifest} from './datasetBuilder.js';
type Group={tokens:string[];fingerprints:string[];split:string};
type Db={query(sql:string,parameters?:any[]):Promise<any[]>};
export class DatasetSplitConflict extends Error{}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export const datasetOwnerScope=(username:string,keyId:string|null)=>digest(JSON.stringify([username,keyId]));
export function resolveDatasetGroups(groups:Group[],known:Map<string,string>):Group[]{
  return groups.map(group=>{
    const assigned=new Set(group.tokens.flatMap(token=>known.has(token)?[known.get(token)!]:[]));
    if(assigned.size>1)throw new DatasetSplitConflict('Dataset split conflict: linked evidence was already exported in different splits');
    return {...group,split:[...assigned][0]??group.split};
  });
}
export async function applyDatasetRegistry(db:Db,dataset:ReturnType<typeof buildDataset>,username:string,keyId:string|null){
  const scope=datasetOwnerScope(username,keyId);
  const tokens=[...new Set(dataset.groups.flatMap(group=>group.tokens))];
  const rows=tokens.length?await db.query(`SELECT token_hash,split FROM dataset_split_registry WHERE owner_scope=$1 AND token_hash=ANY($2::text[])`,[scope,tokens.map(digest)]):[];
  const byHash=new Map<string,string>(rows.map(row=>[row.token_hash.trim(),row.split]));
  const groups=resolveDatasetGroups(dataset.groups,new Map(tokens.flatMap(token=>byHash.has(digest(token))?[[token,byHash.get(digest(token))!] as [string,string]]:[])));
  const splits=new Map(groups.flatMap(group=>group.fingerprints.map(fp=>[fp,group.split] as [string,string])));
  for(const example of dataset.examples)example.metadata.split=splits.get(example.metadata.fingerprint)!;
  dataset.groups=groups;refreshDatasetManifest(dataset);
}
/** Caller holds the per-owner transaction lock; ledger commits before any bytes are returned. */
export async function recordDatasetExport(db:Db,dataset:ReturnType<typeof buildDataset>,value:{username:string;keyId:string|null;split:string;ids:string[];content:string}){
  const scope=datasetOwnerScope(value.username,value.keyId),id=randomUUID();
  const groups=dataset.groups.filter(group=>group.split===value.split);
  const tokens=[...new Set(groups.flatMap(group=>group.tokens))].map(digest);
  if(tokens.length)await db.query(`INSERT INTO dataset_split_registry(owner_scope,token_hash,split)
    SELECT $1,token,$3 FROM unnest($2::text[]) token ON CONFLICT(owner_scope,token_hash) DO NOTHING`,[scope,tokens,value.split]);
  const fileSha256=digest(value.content),byteLength=Buffer.byteLength(value.content,'utf8');
  await db.query(`INSERT INTO dataset_exports(export_id,username,key_id,split,selected_ids,exported_ids,manifest,file_sha256,byte_length)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,value.username,value.keyId,value.split,value.ids,
    dataset.examples.filter(row=>row.metadata.split===value.split).map(row=>row.metadata.resultId),JSON.stringify(dataset.manifest),fileSha256,byteLength]);
  return {id,fileSha256,byteLength};
}
