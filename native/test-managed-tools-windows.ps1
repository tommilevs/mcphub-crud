param(
  [Parameter(Mandatory=$true)][string]$ComputerUseExecutable,
  [Parameter(Mandatory=$true)][string]$DesktopCommanderEntry,
  [string]$PlaywrightEntry,
  [string]$PlaywrightWorkingDirectory,
  [switch]$VerifyPlaywrightConnection
)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runtime=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'target\release\mcphub-runtime-service.exe')).Path
$ComputerUseExecutable=(Resolve-Path -LiteralPath $ComputerUseExecutable).Path
$DesktopCommanderEntry=(Resolve-Path -LiteralPath $DesktopCommanderEntry).Path
if($PlaywrightEntry){
  $PlaywrightEntry=(Resolve-Path -LiteralPath $PlaywrightEntry).Path
  $PlaywrightWorkingDirectory=(Resolve-Path -LiteralPath $PlaywrightWorkingDirectory).Path
}
$pipe='mcphub-user-managed-acceptance-'+[Guid]::NewGuid().ToString('N')
$previous=@{}
foreach($key in @('MCPHUB_MANAGED_ACCEPTANCE_PIPE','MCPHUB_MANAGED_ACCEPTANCE_COMPUTER','MCPHUB_MANAGED_ACCEPTANCE_COMMANDER','MCPHUB_MANAGED_ACCEPTANCE_PLAYWRIGHT','MCPHUB_MANAGED_ACCEPTANCE_PLAYWRIGHT_CWD','MCPHUB_MANAGED_ACCEPTANCE_VERIFY_BROWSER','PLAYWRIGHT_MCP_EXTENSION_TOKEN')){
  $previous[$key]=[Environment]::GetEnvironmentVariable($key,'Process')
}
$agent=$null
Push-Location $repo
try {
  $env:MCPHUB_MANAGED_ACCEPTANCE_VERIFY_BROWSER=$null
  if($VerifyPlaywrightConnection){
    if(-not $PlaywrightEntry){throw 'Playwright entry is required for browser connection verification.'}
    $extensionToken=[Environment]::GetEnvironmentVariable('PLAYWRIGHT_MCP_EXTENSION_TOKEN','User')
    if(-not $extensionToken){throw 'Existing user Playwright extension credential is unavailable.'}
    $env:PLAYWRIGHT_MCP_EXTENSION_TOKEN=$extensionToken
    $env:MCPHUB_MANAGED_ACCEPTANCE_VERIFY_BROWSER='1'
  }
  $agent=Start-Process -FilePath $runtime -ArgumentList @('--user-agent','--pipe-name',$pipe) -WindowStyle Hidden -PassThru
  $ready=[IO.Pipes.NamedPipeClientStream]::new('.',$pipe,[IO.Pipes.PipeDirection]::InOut)
  try{$ready.Connect(10000)}finally{$ready.Dispose()}
  $env:MCPHUB_MANAGED_ACCEPTANCE_PIPE="\\.\pipe\$pipe"
  $env:MCPHUB_MANAGED_ACCEPTANCE_COMPUTER=$ComputerUseExecutable
  $env:MCPHUB_MANAGED_ACCEPTANCE_COMMANDER=$DesktopCommanderEntry
  $env:MCPHUB_MANAGED_ACCEPTANCE_PLAYWRIGHT=$PlaywrightEntry
  $env:MCPHUB_MANAGED_ACCEPTANCE_PLAYWRIGHT_CWD=$PlaywrightWorkingDirectory
  $javascript=@'
import {NativeRuntimeTransport} from './dist/services/nativeRuntimeTransport.js';
import {LegacyMcpClient} from './dist/clients/legacyMcpClient.js';
const definitions=[
  {id:'actual-windows-computer-use',command:process.env.MCPHUB_MANAGED_ACCEPTANCE_COMPUTER,args:['stdio','--toolsets','default,testing']},
  {id:'actual-desktop-commander',command:process.execPath,args:[process.env.MCPHUB_MANAGED_ACCEPTANCE_COMMANDER]},
];
if(process.env.MCPHUB_MANAGED_ACCEPTANCE_PLAYWRIGHT){
  definitions.push({id:'actual-playwright-extension',command:process.execPath,args:[process.env.MCPHUB_MANAGED_ACCEPTANCE_PLAYWRIGHT,'--extension','--profile-dir-name','Default','--allowed-hosts','*','--shared-browser-context'],cwd:process.env.MCPHUB_MANAGED_ACCEPTANCE_PLAYWRIGHT_CWD});
}
for(const definition of definitions){
  const transport=new NativeRuntimeTransport({...definition,env:{},streaming:true,initialize_timeout_ms:60000},process.env.MCPHUB_MANAGED_ACCEPTANCE_PIPE);
  const client=new LegacyMcpClient({name:'managed-tool-acceptance',version:'1'});
  transport.onerror=error=>console.error(JSON.stringify({server:definition.id,transportError:error.message}));
  try{
    await client.connect(transport);
    const listed=await client.listTools();
    if(!Array.isArray(listed.tools)||!listed.tools.length)throw new Error(definition.id+' did not expose any tools');
    console.log(JSON.stringify({server:definition.id,toolCount:listed.tools.length,toolNames:listed.tools.map(t=>t.name)}));
    if(definition.id==='actual-playwright-extension'){
      if(!listed.tools.some(t=>t.name==='browser_tabs'))throw new Error('Playwright browser_tabs tool unavailable');
      let browserConnectionVerified=false;
      if(process.env.MCPHUB_MANAGED_ACCEPTANCE_VERIFY_BROWSER==='1'){
        const tabs=await client.callTool({name:'browser_tabs',arguments:{action:'list'}},undefined,{timeout:30000});
        if(tabs.isError||!tabs.content?.some(c=>c.type==='text'&&c.text?.length))throw new Error('Playwright extension connection failed; browser content was not logged');
        browserConnectionVerified=true;
      }
      console.log(JSON.stringify({server:definition.id,stdioDiscoverySucceeded:true,browserConnectionVerified}));
      continue;
    }
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
  $extensionToken=$null
  if($agent){try{if(-not $agent.HasExited){$agent.Kill();$agent.WaitForExit()}}finally{$agent.Dispose()}}
  foreach($key in $previous.Keys){[Environment]::SetEnvironmentVariable($key,$previous[$key],'Process')}
  Pop-Location
}
Write-Output 'Actual desktop tool servers initialized through the native user agent; temporary host removed.'
