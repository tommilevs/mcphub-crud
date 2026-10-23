/** Empty scope is general; malformed constraints must never widen applicability. */
export function experienceAppliesTo(value:unknown,server:string,tool:string):boolean{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const scope=value as Record<string,unknown>;
  if(Object.keys(scope).some(key=>!['servers','tools'].includes(key)))return false;
  for(const name of ['servers','tools']){
    const list=scope[name];
    if(list===undefined)continue;
    if(!Array.isArray(list)||list.some(item=>typeof item!=='string'))return false;
    const target=name==='servers'?server:`${server}/${tool}`;
    if(list.length&&!list.includes(target))return false;
  }
  return true;
}
