param(
  [Parameter(Mandatory=$true)][string]$ComputerUseExecutable,
  [Parameter(Mandatory=$true)][string]$DesktopCommanderEntry
)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runtime=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'target\release\mcphub-runtime-service.exe')).Path
$ComputerUseExecutable=(Resolve-Path -LiteralPath $ComputerUseExecutable).Path
$DesktopCommanderEntry=(Resolve-Path -LiteralPath $DesktopCommanderEntry).Path
$pipe='mcphub-user-managed-acceptance-'+[Guid]::NewGuid().ToString('N')
$previous=@{}
foreach($key in @('MCPHUB_MANAGED_ACCEPTANCE_PIPE','MCPHUB_MANAGED_ACCEPTANCE_COMPUTER','MCPHUB_MANAGED_ACCEPTANCE_COMMANDER')){
  $previous[$key]=[Environment]::GetEnvironmentVariable($key,'Process')
}
$agent=$null
Push-Location $repo
try {
  $agent=Start-Process -FilePath $runtime -ArgumentList @('--user-agent','--pipe-name',$pipe) -WindowStyle Hidden -PassThru
  $ready=[IO.Pipes.NamedPipeClientStream]::new('.',$pipe,[IO.Pipes.PipeDirection]::InOut)
  try{$ready.Connect(10000)}finally{$ready.Dispose()}
  $env:MCPHUB_MANAGED_ACCEPTANCE_PIPE="\\.\pipe\$pipe"
  $env:MCPHUB_MANAGED_ACCEPTANCE_COMPUTER=$ComputerUseExecutable
  $env:MCPHUB_MANAGED_ACCEPTANCE_COMMANDER=$DesktopCommanderEntry
  $javascript=@'
import {NativeRuntimeTransport} from './dist/services/nativeRuntimeTransport.js';
import {LegacyMcpClient} from './dist/clients/legacyMcpClient.js';
const definitions=[
  {id:'actual-windows-computer-use',command:process.env.MCPHUB_MANAGED_ACCEPTANCE_COMPUTER,args:['stdio','--toolsets','default,testing']},
  {id:'actual-desktop-commander',command:process.execPath,args:[process.env.MCPHUB_MANAGED_ACCEPTANCE_COMMANDER]},
];
for(const definition of definitions){
  const transport=new NativeRuntimeTransport({...definition,env:{},streaming:true,initialize_timeout_ms:60000},process.env.MCPHUB_MANAGED_ACCEPTANCE_PIPE);
  const client=new LegacyMcpClient({name:'managed-tool-acceptance',version:'1'});
  transport.onerror=error=>console.error(JSON.stringify({server:definition.id,transportError:error.message}));
  try{
    await client.connect(transport);
    const listed=await client.listTools();
    if(!Array.isArray(listed.tools)||!listed.tools.length)throw new Error(definition.id+' did not expose any tools');
    console.log(JSON.stringify({server:definition.id,toolCount:listed.tools.length,toolNames:listed.tools.map(t=>t.name)}));
    const metadataTool=definition.id==='actual-windows-computer-use'?'GuardrailStatus':'get_config';
    if(!listed.tools.some(t=>t.name===metadataTool))throw new Error('Expected metadata tool is unavailable: '+metadataTool);
    const metadata=await client.callTool({name:metadataTool,arguments:{}});
    if(metadata.isError||!metadata.content?.length)throw new Error(definition.id+' metadata call failed');
    if(metadataTool==='GuardrailStatus'){
      const status=JSON.parse(metadata.content.find(c=>c.type==='text').text);
      if(status.admit!==true||status.killed||status.server?.killed)throw new Error('Windows tool guardrail denies admission; policy was not changed');
      if(status.device?.hostname?.toLowerCase()!==process.env.COMPUTERNAME.toLowerCase())throw new Error('Windows metadata returned another device');
    }
    console.log(JSON.stringify({server:definition.id,metadataTool,metadataCallSucceeded:true}));
  }finally{await client.close();}
}
'@
  & (Join-Path ${env:ProgramFiles} 'nodejs\node.exe') --input-type=module -e $javascript
  if($LASTEXITCODE -ne 0){throw 'Actual managed stdio server acceptance failed.'}
}finally{
  if($agent){try{if(-not $agent.HasExited){$agent.Kill();$agent.WaitForExit()}}finally{$agent.Dispose()}}
  foreach($key in $previous.Keys){[Environment]::SetEnvironmentVariable($key,$previous[$key],'Process')}
  Pop-Location
}
Write-Output 'Actual desktop tool servers initialized through the native user agent; temporary host removed.'
