// Offline paired evaluation. No gateway requests, provider calls or credentials.
import fs from 'node:fs';

const methods=['baseline','mcpZero'];
const fail=message=>{throw new Error(message);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const identity=tool=>JSON.stringify([tool.serverName,tool.toolName]);
function tools(value,where){
  if(!Array.isArray(value)||value.length>10000)fail(`${where}: expected a bounded tool list`);
  const seen=new Set();
  for(const tool of value){
    if(!object(tool)||typeof tool.serverName!=='string'||!tool.serverName.trim()||typeof tool.toolName!=='string'||!tool.toolName.trim())fail(`${where}: invalid tool identity`);
    const key=identity(tool);
    if(seen.has(key))fail(`${where}: duplicate tool identity`);
    seen.add(key);
  }
  return seen;
}
function measurement(value,field,where){
  if(value===undefined)return;
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||(field!=='latencyMs'&&!Number.isInteger(value)))fail(`${where}: invalid ${field}`);
}
const average=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
function measured(rows,field){
  const values=rows.map(row=>row[field]).filter(value=>value!==undefined).sort((a,b)=>a-b);
  return {samples:values.length,mean:average(values),p50:values.length?values[Math.ceil(values.length*0.5)-1]:null,p95:values.length?values[Math.ceil(values.length*0.95)-1]:null};
}
function ranking(predicted,relevant,k){
  let hits=0,dcg=0,first=0;
  predicted.slice(0,k).forEach((tool,index)=>{
    if(relevant.has(identity(tool))){hits++;dcg+=1/Math.log2(index+2);if(!first)first=index+1;}
  });
  let ideal=0;
  for(let i=0;i<Math.min(k,relevant.size);i++)ideal+=1/Math.log2(i+2);
  return {precision:hits/k,recall:relevant.size?hits/relevant.size:null,
    mrr:relevant.size?(first?1/first:0):null,ndcg:ideal?dcg/ideal:null,
    abstention:relevant.size?null:Number(predicted.length===0)};
}
function evaluate(input){
  if(!object(input)||input.version!==1||!Number.isInteger(input.k)||input.k<1||input.k>100)fail('expected version 1 and k between 1 and 100');
  if(!Array.isArray(input.cases)||!input.cases.length||input.cases.length>10000)fail('expected 1–10000 paired cases');
  const evidence={synthetic:0,recorded:0,live:0},phases={},seen=new Set();
  for(const row of input.cases){
    if(!object(row)||typeof row.id!=='string'||!row.id.trim()||seen.has(row.id))fail('case IDs must be nonempty and unique');
    seen.add(row.id);
    if(!['cold','warm'].includes(row.phase))fail(`${row.id}: invalid phase`);
    if(!Object.hasOwn(evidence,row.evidence))fail(`${row.id}: invalid evidence type`);
    evidence[row.evidence]++;
    const relevant=tools(row.relevant,`${row.id}/relevant`);
    const phase=phases[row.phase]??={baseline:[],mcpZero:[]};
    for(const method of methods){
      const observation=row[method],where=`${row.id}/${method}`;
      if(!object(observation))fail(`${where}: missing paired observation`);
      tools(observation.tools,where);
      for(const field of ['latencyMs','outputTokens','embeddingRequests'])measurement(observation[field],field,where);
      phase[method].push({...observation,...ranking(observation.tools,relevant,input.k)});
    }
  }
  for(const phase of Object.values(phases))for(const method of methods){
    const rows=phase[method];
    phase[method]={cases:rows.length,answerableCases:rows.filter(row=>row.recall!==null).length,
      unanswerableCases:rows.filter(row=>row.abstention!==null).length,
      ...Object.fromEntries(['precision','recall','mrr','ndcg'].map(field=>[field,average(rows.map(row=>row[field]).filter(value=>value!==null))])),
      abstentionAccuracy:average(rows.map(row=>row.abstention).filter(value=>value!==null)),
      latencyMs:measured(rows,'latencyMs'),outputTokens:measured(rows,'outputTokens'),embeddingRequests:measured(rows,'embeddingRequests')};
  }
  return {version:1,k:input.k,evidence,phases,
    limitations:['Evidence labels and measurements are supplied by the caller, not independently verified.',
      'Macro means use paired case rows; repeat each query equally to avoid weighting bias.',
      'Missing measurements are null, not zero. Token counts are observations, not currency estimates.',
      'This report does not establish deployed retrieval quality without representative live or recorded observations.']};
}
try{
  const file=process.argv[2];
  if(process.argv.length>3)fail('usage: node scripts/evaluate-smart-routing.js [observations.json] (or JSON on stdin)');
  const result=evaluate(JSON.parse(fs.readFileSync(file??0,'utf8')));
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(error){
  // Do not echo payloads: local observations may contain private identifiers.
  process.stderr.write(`Smart Routing evaluation failed: ${error instanceof SyntaxError?'invalid JSON':error.message}\n`);
  process.exitCode=1;
}
