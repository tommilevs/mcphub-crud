import {locateRawChunk} from '../../frontend/src/utils/rawChunkLocation';
it.each([1,2])('maps chunk version %s through JSON escaping without rewriting RAW',chunkVersion=>{
 const text='first\r\nGPU "Xid 79" 😀\r\nlast';
 const raw=JSON.stringify({content:[{type:'text',text}]});
 const prefix='srv\nread\nobjective\n',content=prefix+text;
 const hit=locateRawChunk(raw,{server:'srv',tool:'read',objective:'objective'},{chunkIndex:0,chunkVersion,content},[{chunkIndex:0,chunkVersion,content}]);
 expect(hit).not.toBeNull();
 expect(raw.slice(hit!.start,hit!.end)).toBe(JSON.stringify(text).slice(1,-1));
});
it('locates the correct occurrence of repeated chunks using the complete index',()=>{
 const raw=JSON.stringify({content:[{type:'text',text:'same\nsame\n'}]});
 const chunks=[{chunkIndex:0,chunkVersion:1,content:'srv\nread\nsame\n'},{chunkIndex:1,chunkVersion:1,content:'same\n'}];
 const hit=locateRawChunk(raw,{server:'srv',tool:'read'},chunks[1],chunks);
 expect(raw.slice(hit!.start,hit!.end)).toBe('same\\n');
 expect(hit!.start).toBe(raw.lastIndexOf('same'));
});
it('refuses ambiguous or stale content rather than highlighting an unrelated location',()=>{
 const raw=JSON.stringify({content:[{type:'text',text:'same'},{type:'text',text:'same'}]});
 expect(locateRawChunk(raw,{server:'srv',tool:'read'},{chunkIndex:0,chunkVersion:1,content:'same'},[])).toBeNull();
 expect(locateRawChunk(raw,{server:'srv',tool:'read'},{chunkIndex:0,chunkVersion:1,content:'missing'},[])).toBeNull();
});
it('maps an interior diagnostic through escaped quotes, line endings and Unicode',()=>{
 const first='first 😀\r\n',last='GPU "Xid 79"\r\n';
 const raw=JSON.stringify({content:[{type:'text',text:first+last}]});
 const chunks=[{chunkIndex:0,chunkVersion:1,content:'srv\nread\n'+first},{chunkIndex:1,chunkVersion:1,content:last}];
 const hit=locateRawChunk(raw,{server:'srv',tool:'read'},chunks[1],chunks);
 expect(raw.slice(hit!.start,hit!.end)).toBe(JSON.stringify(last).slice(1,-1));
});
it('finds structured output and the first source block of a cross-block chunk',()=>{
 const raw=JSON.stringify({content:[{type:'text',text:'alpha'},{type:'text',text:'beta'}],structuredContent:{diagnostic:'Xid 79'}});
 const content='srv\nread\nalpha\nbeta\n{"diagnostic":"Xid 79"}';
 const chunk={chunkIndex:0,chunkVersion:1,content};
 const hit=locateRawChunk(raw,{server:'srv',tool:'read'},chunk,[chunk]);
 expect(raw.slice(hit!.start,hit!.end)).toBe('alpha');
 const structured={chunkIndex:1,chunkVersion:1,content:'{"diagnostic":"Xid 79"}'};
 const found=locateRawChunk(raw,{server:'srv',tool:'read'},structured,[]);
 expect(raw.slice(found!.start,found!.end)).toBe(structured.content);
});
