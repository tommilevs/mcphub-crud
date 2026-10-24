; Tauri NSIS lifecycle hooks for the managed MCPHub runtime service.
; The service binary is bundled beside the tray executable.

!macro NSIS_HOOK_POSTINSTALL
  Push $R8
  Push $R9
  ReadEnvStr $R8 "ProgramData"
  StrCpy $R9 "0"
  IfFileExists "$R8\MCPHub\secrets\bootstrap-admin.dpapi" +2 0
  StrCpy $R9 "1"
  ; Replace an older registration during upgrades.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop MCPHub'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete MCPHub'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" create MCPHub binPath= "$INSTDIR\mcphub-runtime-service.exe" start= auto DisplayName= "MCPHub Runtime Service"'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" failure MCPHub reset= 86400 actions= restart/5000/restart/15000/restart/60000'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" description MCPHub "MCPHub managed stdio MCP runtime and watchdog"'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" start MCPHub'
  IfSilent +3 0
  StrCmp $R9 "1" 0 +2
  ExecWait '"$INSTDIR\mcphub-runtime-service.exe" --show-initial-password'
  Pop $R9
  Pop $R8
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop MCPHub'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete MCPHub'
!macroend
