param([Parameter(Mandatory=$true)][string]$InstallerPath,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows'){
  throw 'Wizard acceptance requires disposable GitHub-hosted Windows.'
}
$expected=Join-Path $env:RUNNER_TEMP 'MCPHub-Installer-Acceptance'
if([IO.Path]::GetFullPath($Destination) -ne [IO.Path]::GetFullPath($expected) -or (Test-Path -LiteralPath $Destination)){
  throw 'Wizard destination must be the fresh acceptance directory.'
}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WizardButtons {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
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
      $condition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$ownerId)
      $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$condition)
      $windowCount=$windows.Count
      foreach($window in $windows){
        $buttons=@($window.FindAll([Windows.Automation.TreeScope]::Descendants,
          [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button)))
        # Never enumerate Text controls or read the bootstrap-password dialog.
        $isPassword=$passwordOwners -contains $ownerId
        $edits=@()
        if(-not $isPassword){
          foreach($edit in $window.FindAll([Windows.Automation.TreeScope]::Descendants,
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit))){
            $valuePattern=$null
            if($edit.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$valuePattern)){
              $value=$valuePattern.Current.Value
              $edits+=$value
              if($value -match '^[A-Za-z]:\\'){
                if(-not [string]::Equals($value.TrimEnd('\'),$Destination.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)){
                  throw 'Wizard proposed an unexpected installation path.'
                }
                $destinationObserved=$true
              }
            }
          }
        }
        $active=@($buttons | Where-Object {$_.Current.IsEnabled -and -not $_.Current.IsOffscreen})
        $visibleButtonCount=$active.Count
        $pageKey=(@($window.Current.NativeWindowHandle,$isPassword)+@($active | ForEach-Object {$_.Current.Name})+$edits) -join '|'
        if($pageKey -eq $lastPage){continue}
        foreach($button in $active){
          $label=$button.Current.Name.Replace('&','').Trim()
          if($isPassword){if($label -ne 'OK'){continue}}
          elseif($label -notin @('OK','Next >','Next','I Agree','Install','Finish')){continue}
          if($label -in @('Install','Finish') -and -not $destinationObserved){throw 'Wizard never confirmed the acceptance destination.'}
          if($label -eq 'Finish'){
            foreach($checkbox in $window.FindAll([Windows.Automation.TreeScope]::Descendants,
              [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::CheckBox))){
              $toggle=$null
              if($checkbox.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$toggle) -and $toggle.Current.ToggleState -eq [Windows.Automation.ToggleState]::On){$toggle.Toggle()}
            }
            $finished=$true
          }
          $handle=[IntPtr]$button.Current.NativeWindowHandle
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
