import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{
  const request=JSON.parse(line);if(request.id===undefined)return;
  let result;
  switch(request.method){
    case 'initialize':result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'native-acceptance-fixture',version:'1'}};break;
    case 'ping':result={};break;
    case 'tools/list':result={tools:[{name:'check_secret',inputSchema:{type:'object',properties:{expected:{type:'string'}},required:['expected']}}]};break;
    case 'tools/call':result={content:[{type:'text',text:JSON.stringify({secretMatches:process.env.MCPHUB_NATIVE_TEST_SECRET===request.params.arguments.expected})}]};break;
    default:process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}})+'\n');return;
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
