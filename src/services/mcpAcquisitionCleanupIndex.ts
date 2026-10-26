import type {DataSource} from 'typeorm';

/** Drain queued embedding writes BEFORE taking this guard. The settings/runtime
 * adoption guards must also span work; an empty index alone never permits deletion.
 * Missing/unreadable tables indicate incomplete database initialization. */
export async function withCleanupIndexGuard<T>(db:Pick<DataSource,'transaction'>,
  serverNames:readonly string[],work:()=>Promise<T>):Promise<T>{
  if(!serverNames.length||serverNames.length>100||serverNames.some(name=>!name.trim()||name.length>255))
    throw new Error('Invalid cleanup index identity');
  return db.transaction('SERIALIZABLE',async manager=>{
    let referenced:unknown;
    try{
      const relation=await manager.query("SELECT to_regclass('vector_embeddings')::text AS relation");
      if(!relation[0]?.relation)throw new Error('Missing index');
      await manager.query('LOCK TABLE vector_embeddings IN SHARE ROW EXCLUSIVE MODE');
      const rows=await manager.query(`SELECT EXISTS(SELECT 1 FROM vector_embeddings
        WHERE content_type IN ('tool','server') AND ((metadata::jsonb->>'serverName')=ANY($1::text[])
          OR (content_type='server' AND content_id=ANY($1::text[]))
          OR (content_type='tool' AND split_part(content_id,':',1)=ANY($1::text[])))) AS referenced`,[[...serverNames]]);
      referenced=rows[0]?.referenced;
    }catch{throw new Error('Cleanup index state is unconfirmed');}
    if(referenced===true)throw new Error('Cleanup references remain in the vector index');
    if(referenced!==false)throw new Error('Cleanup index state is unconfirmed');
    return work();
  });
}
