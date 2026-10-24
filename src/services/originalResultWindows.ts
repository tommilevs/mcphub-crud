export interface OriginalWindow {start:number;end:number;text:string;}
/** Structural boundaries are preferences, never permission to rewrite source text. */
export function originalResultWindows(text:string,maxChars:number,bodyStart=0):OriginalWindow[]{
 if(!Number.isSafeInteger(maxChars)||maxChars<2||!Number.isSafeInteger(bodyStart)||bodyStart<0||bodyStart>text.length)throw new RangeError('Invalid original window size or body offset');
 const boundaries:Array<{end:number;depth:number}>=[];
 const body=text.slice(bodyStart).trim();
 let json=false;
 if(/^[\[{]/.test(body)){try{JSON.parse(body);json=true;}catch{/* Treat malformed or mixed JSON as original text. */}}
 if(json){
  let depth=0,quoted=false,escaped=false;
  for(let index=bodyStart;index<text.length;index++){
   const char=text[index];
   if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
   if(char==='"')quoted=true;
   else if(char==='['||char==='{')depth++;
   else if(char===']'||char==='}')depth--;
   else if(char===',')boundaries.push({end:index+1,depth});
  }
 }else if(/^(?:diff --git |@@ )/m.test(body)){
  const regex=/^(?:diff --git |@@ )/gm;let match:RegExpExecArray|null;
  const originalBody=text.slice(bodyStart);
  while((match=regex.exec(originalBody)))boundaries.push({end:bodyStart+match.index,depth:0});
 }
 const windows:OriginalWindow[]=[];let cursor=0;
 for(let start=0;start<text.length;){
  let end=Math.min(start+maxChars,text.length);
  if(end<text.length){
   while(cursor<boundaries.length&&boundaries[cursor].end<=start)cursor++;
   let chosen=0,depth=Infinity;
   for(let index=cursor;index<boundaries.length&&boundaries[index].end<=end;index++){
    const boundary=boundaries[index];
    if(boundary.depth<=depth){if(boundary.depth<depth)depth=boundary.depth;chosen=boundary.end;}
   }
   if(chosen>start)end=chosen;
   else {const newline=text.lastIndexOf('\n',end-1);if(newline>=start)end=newline+1;}
   if(/[\uD800-\uDBFF]/.test(text[end-1])&&/[\uDC00-\uDFFF]/.test(text[end]))end--;
   if(text[end-1]==='\r'&&text[end]==='\n')end--;
  }
  windows.push({start,end,text:text.slice(start,end)});start=end;
 }
 return windows;
}
