param([Parameter(Mandatory=$true)][string]$InstallerPath,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows'){
  throw 'Wizard acceptance requires disposable GitHub-hosted Windows.'
}
$expected=Join-Path $env:RUNNER_TEMP 'MCPHub-Installer-Acceptance'
if([IO.Path]::GetFullPath($Destination) -ne [IO.Path]::GetFullPath($expected) -or (Test-Path -LiteralPath $Destination)){
  throw 'Wizard destination must be the fresh acceptance directory.'
}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class WizardButtons {
  private delegate bool EnumWindow(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr state);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindow callback, IntPtr state);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] private static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr size, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static IntPtr[] Windows(int owner) {
    var handles=new List<IntPtr>();
    EnumWindows((window,state)=>{uint process;GetWindowThreadProcessId(window,out process);if(process==owner)handles.Add(window);return true;},IntPtr.Zero);
    return handles.ToArray();
  }
  public static IntPtr[] Children(IntPtr parent) {
    var handles=new List<IntPtr>();
    EnumChildWindows(parent,(window,state)=>{handles.Add(window);return true;},IntPtr.Zero);
    return handles.ToArray();
  }
  public static string Class(IntPtr window) {var name=new StringBuilder(128);GetClassName(window,name,name.Capacity);return name.ToString();}
  public static string ControlText(IntPtr window) {
    var kind=Class(window);
    if(kind!="Button" && kind!="Edit")throw new InvalidOperationException("Only button and directory-edit text may be inspected.");
    var text=new StringBuilder(32768);UIntPtr result;
    if(SendMessageTimeout(window,0x000D,(UIntPtr)text.Capacity,text,2,1000,out result)==IntPtr.Zero)return "";
    return text.ToString();
  }
  public static bool CheckedBox(IntPtr window) {
    int style=GetWindowLong(window,-16)&15;
    if(style!=2 && style!=3 && style!=5 && style!=6)return false;
    UIntPtr result;SendMessageTimeout(window,0x00F0,UIntPtr.Zero,null,2,1000,out result);
    return result.ToUInt64()!=0;
  }
}
'@
# This is the interactive UI under test on a disposable runner, not a background
# helper. A hidden wizard has no accessible top-level UIAutomation window.
$process=Start-Process -FilePath $InstallerPath -ArgumentList "/D=$Destination" -WindowStyle Normal -PassThru
$destinationObserved=$false;$finished=$false;$passwordAcknowledged=$false;$lastPage=''
$windowCount=0;$visibleButtonCount=0;$lastAction='none';$actionCount=0
try{
  $deadline=[DateTime]::UtcNow.AddMinutes(5)
  while([DateTime]::UtcNow -lt $deadline){
    $process.Refresh()
    if($process.HasExited){break}
    $owners=@($process.Id)
    # NSIS may keep its launcher alive while a child owns the actual wizard.
    $processTree=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId)
    do{
      $children=@($processTree | Where-Object {$owners -contains [int]$_.ParentProcessId -and $owners -notcontains [int]$_.ProcessId} | ForEach-Object {[int]$_.ProcessId})
      $owners+=$children
    }while($children.Count -gt 0)
    $passwordOwners=@(Get-CimInstance Win32_Process -Filter "Name='mcphub-runtime-service.exe'" | Where-Object {
      $_.ExecutablePath -eq (Join-Path $Destination 'mcphub-runtime-service.exe') -and $_.CommandLine -match '--show-initial-password'
    } | ForEach-Object {[int]$_.ProcessId})
    $owners+=$passwordOwners
    foreach($ownerId in $owners){
      $windows=@([WizardButtons]::Windows($ownerId))
      $windowCount=$windows.Count
      foreach($window in $windows){
        $controls=@([WizardButtons]::Children($window))
        $buttons=@($controls | Where-Object {[WizardButtons]::Class($_) -eq 'Button'})
        # Never enumerate Text controls or read the bootstrap-password dialog.
        $isPassword=$passwordOwners -contains $ownerId
        $edits=@()
        if(-not $isPassword){
          foreach($edit in @($controls | Where-Object {[WizardButtons]::Class($_) -eq 'Edit'})){
              $value=[WizardButtons]::ControlText($edit)
              $edits+=$value
              if($value -match '^[A-Za-z]:\\'){
                if(-not [string]::Equals($value.TrimEnd('\'),$Destination.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)){
                  throw 'Wizard proposed an unexpected installation path.'
                }
                $destinationObserved=$true
              }
          }
        }
        $active=@($buttons | Where-Object {[WizardButtons]::IsWindowEnabled($_) -and [WizardButtons]::IsWindowVisible($_)})
        $visibleButtonCount=$active.Count
        $pageKey=(@($window,$isPassword)+@($active | ForEach-Object {[WizardButtons]::ControlText($_)})+$edits) -join '|'
        if($pageKey -eq $lastPage){continue}
        foreach($button in $active){
          $label=[WizardButtons]::ControlText($button).Replace('&','').Trim()
          if($isPassword){if($label -ne 'OK'){continue}}
          elseif($label -notin @('OK','Next >','Next','I Agree','Install','Finish')){continue}
          if($label -in @('Install','Finish') -and -not $destinationObserved){throw 'Wizard never confirmed the acceptance destination.'}
          if($label -eq 'Finish'){
            foreach($checkbox in @($buttons | Where-Object {[WizardButtons]::CheckedBox($_)})){
              if(-not [WizardButtons]::PostMessage($checkbox,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Cannot clear Finish-page checkbox.'}
            }
            $finished=$true
          }
          [WizardButtons]::SetForegroundWindow($window)|Out-Null
          $handle=[IntPtr]$button
          if($handle -eq [IntPtr]::Zero -or -not [WizardButtons]::PostMessage($handle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)){
            throw 'Wizard button activation failed.'
          }
          if($isPassword){$passwordAcknowledged=$true}
          $lastAction=$label;$actionCount++
          Write-Output "Wizard button posted: $label (password dialog: $isPassword)."
          $lastPage=$pageKey
          break
        }
      }
    }
    Start-Sleep -Milliseconds 250
  }
  if(-not $process.HasExited){throw "Wizard acceptance timed out: windows=$windowCount, visibleButtons=$visibleButtonCount, actions=$actionCount, last=$lastAction, destination=$destinationObserved, passwordAcknowledged=$passwordAcknowledged."}
  if($process.ExitCode -ne 0 -or -not $finished -or -not $destinationObserved -or -not $passwordAcknowledged){
    throw "Wizard acceptance incomplete: exit=$($process.ExitCode), destination=$destinationObserved, finish=$finished, passwordAcknowledged=$passwordAcknowledged."
  }
  Write-Output 'Interactive wizard passed: destination verified, initial-password dialog acknowledged without reading its contents, Finish completed.'
}finally{
  if(-not $process.HasExited){$process.Kill();$process.WaitForExit(10000)|Out-Null}
  $process.Dispose()
}
