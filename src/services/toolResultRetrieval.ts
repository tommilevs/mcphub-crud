export interface OriginalResultFragment {start:number;end:number;text:string;score:number;}
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
 for(let start=0;start<text.length;){
  let end=Math.min(text.length,start+width);
  if(end<text.length){
   const newline=text.lastIndexOf('\n',end-1);
   if(newline>=start)end=newline+1;
   if(/[\uD800-\uDBFF]/.test(text[end-1])&&/[\uDC00-\uDFFF]/.test(text[end]))end--;
  }
  const content=text.slice(start,end),words=tokens(content),counts=new Map<string,number>();
  for(const word of words)counts.set(word,(counts.get(word)??0)+1);
  for(const term of terms)if(counts.has(term))frequencies.set(term,(frequencies.get(term)??0)+1);
  chunks.push({start,end,text:content,score:0,terms:counts,length:words.length});
  start=end;
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
