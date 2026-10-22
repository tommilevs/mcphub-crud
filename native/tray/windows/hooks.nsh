; Tauri NSIS lifecycle hooks for the managed MCPHub runtime service.
; The service binary is bundled beside the tray executable.

!macro NSIS_HOOK_POSTINSTALL
  ; Replace an older registration during upgrades.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop MCPHub'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete MCPHub'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" create MCPHub binPath= "$INSTDIR\mcphub-runtime-service.exe" start= auto DisplayName= "MCPHub Runtime Service"'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" failure MCPHub reset= 86400 actions= restart/5000/restart/15000/restart/60000'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" description MCPHub "MCPHub managed stdio MCP runtime and watchdog"'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" start MCPHub'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop MCPHub'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete MCPHub'
!macroend
