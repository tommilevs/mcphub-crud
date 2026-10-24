; The same service lifecycle script is exercised by native acceptance.
!define MCPHUB_INSTALL_HELPER "${__FILEDIR__}\runtime-install.ps1"

!macro MCPHUB_RUNTIME_LIFECYCLE ACTION SCRIPT
  Push $R0
  Push $R1
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${SCRIPT}" -Action ${ACTION} -InstallDirectory "$INSTDIR"'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" mcphub_lifecycle_${ACTION}_done
  MessageBox MB_ICONSTOP|MB_OK "MCPHub ${ACTION} failed. Installation cannot continue.$\r$\n$R1" /SD IDOK
  Pop $R1
  Pop $R0
  SetErrorLevel 1
  Abort
  mcphub_lifecycle_${ACTION}_done:
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  File /oname=$PLUGINSDIR\mcphub-runtime-install.ps1 "${MCPHUB_INSTALL_HELPER}"
  !insertmacro MCPHUB_RUNTIME_LIFECYCLE Prepare "$PLUGINSDIR\mcphub-runtime-install.ps1"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $R8
  Push $R9
  ReadEnvStr $R8 "ProgramData"
  StrCpy $R9 "0"
  IfFileExists "$R8\MCPHub\secrets\bootstrap-admin.dpapi" +2 0
  StrCpy $R9 "1"
  !insertmacro MCPHUB_RUNTIME_LIFECYCLE Install "$INSTDIR\runtime-install.ps1"
  IfSilent +3 0
  StrCmp $R9 "1" 0 +2
  ExecWait '"$INSTDIR\mcphub-runtime-service.exe" --show-initial-password'
  Pop $R9
  Pop $R8
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MCPHUB_RUNTIME_LIFECYCLE Uninstall "$INSTDIR\runtime-install.ps1"
!macroend
