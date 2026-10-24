interface Chunk {chunkIndex:number;chunkVersion:number;content:string;}
/** Locate original serialized RAW text by validated evidence, never guessed offsets. */
export function locateRawChunk(raw:string,metadata:{server:string;tool:string;objective?:string},chunk:Chunk,chunks:Chunk[]):{start:number;end:number}|null{
 try{
  const payload=JSON.parse(raw);
  if(!Array.isArray(payload?.content))return null;
  const texts=payload.content.filter((block:unknown)=>block&&typeof(block as {text?:unknown}).text==='string').map((block:{text:string})=>block.text);
  const joined=texts.join('\n');
  const structured=payload.structuredContent===undefined?undefined:JSON.stringify(payload.structuredContent);
  const text=structured===undefined?joined:[joined,structured].filter(Boolean).join('\n');
  const prefix=[metadata.server,metadata.tool,metadata.objective].filter(Boolean).join('\n')+(text?'\n':'');
  const searchable=prefix+text;
  const version=chunks.filter(item=>item.chunkVersion===chunk.chunkVersion).sort((a,b)=>a.chunkIndex-b.chunkIndex);
  let start=-1;
  if(version.every((item,index)=>item.chunkIndex===index)&&version.map(item=>item.content).join('')===searchable){
   const indexed=version[chunk.chunkIndex];
   if(indexed?.content!==chunk.content)return null;
   start=version.slice(0,chunk.chunkIndex).reduce((sum,item)=>sum+item.content.length,0);
  }else{
   start=searchable.indexOf(chunk.content);
   if(start<0||searchable.indexOf(chunk.content,start+1)>=0)return null;
  }
  const end=start+chunk.content.length;
  let offset=prefix.length;
  for(let index=0;index<texts.length;index++){
   const value=texts[index],from=Math.max(start,offset),to=Math.min(end,offset+value.length);
   if(from<to){
    const encoded=JSON.stringify(value),position=raw.indexOf(encoded);
    if(position<0||raw.indexOf(encoded,position+1)>=0)return null;
    return {start:position+1+JSON.stringify(value.slice(0,from-offset)).length-2,end:position+1+JSON.stringify(value.slice(0,to-offset)).length-2};
   }
   offset+=value.length+1;
  }
  if(structured!==undefined){
   offset=prefix.length+(joined?joined.length+1:0);
   const from=Math.max(start,offset),to=Math.min(end,offset+structured.length),position=raw.indexOf(structured);
   if(from<to&&position>=0&&raw.indexOf(structured,position+1)<0)return {start:position+from-offset,end:position+to-offset};
  }
 }catch{/* Malformed historical RAW or stale indexes are not evidence of a location. */}
 return null;
}
