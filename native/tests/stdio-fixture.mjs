import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
const waiting=new Map();let cancelled=0;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
lines.on('line',line=>{
  const request=JSON.parse(line);
  if(request.method==='notifications/cancelled'){
    const original=waiting.get(`hang-${request.params.requestId}`);
    if(original){waiting.delete(`hang-${request.params.requestId}`);cancelled++;send({jsonrpc:'2.0',id:original.id,error:{code:-32800,message:'Cancelled'}});}return;
  }
  if(request.id===undefined)return;
  if(request.method===undefined&&waiting.has(request.id)){
    const original=waiting.get(request.id);waiting.delete(request.id);
    send({jsonrpc:'2.0',id:original.id,result:{content:[{type:'text',text:'duplex-complete'}]}});return;
  }
  let result;
  switch(request.method){
    case 'initialize':result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'native-acceptance-fixture',version:'1'}};break;
    case 'ping':result={};break;
    case 'tools/list':result={tools:[{name:'check_secret',inputSchema:{type:'object',properties:{expected:{type:'string'}},required:['expected']}},
      ...['duplex','hang','counts'].map(name=>({name,inputSchema:{type:'object'}}))]};break;
    case 'tools/call':
      if(request.params.name==='duplex'){
        const id=`server-${request.id}`;waiting.set(id,request);
        send({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:'fixture',progress:1}});
        send({jsonrpc:'2.0',id,method:'ping'});return;
      }
      if(request.params.name==='hang'){waiting.set(`hang-${request.id}`,request);return;}
      result={content:[{type:'text',text:JSON.stringify(request.params.name==='counts'?{cancelled}:{secretMatches:process.env.MCPHUB_NATIVE_TEST_SECRET===request.params.arguments.expected})}]};break;
    default:process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}})+'\n');return;
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
