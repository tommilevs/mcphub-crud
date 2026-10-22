# MCPHub native runtime

This workspace is the native foundation for the Windows release. `runtime-core`
supervises managed stdio MCP processes and restarts crashed children within a
bounded policy. On Windows every child is attached to a Job Object so the
service can terminate the full process tree. `service` exposes a JSON-lines
development transport on non-Windows and a named-pipe control transport on
Windows. `tray` keeps the dashboard hidden until requested, exposes
dashboard/restart/exit actions, and is packaged as an NSIS installer.

The Node gateway uses the native service only when
`MCPHUB_NATIVE_RUNTIME_ENABLED=true` is set on Windows. The default SDK stdio
transport remains unchanged. Install the service after building with:

```powershell
./native/service/install.ps1 -Action install
```

The service executable is taken from `native/target/release` and is configured
to start automatically with Windows. The service receives resolved command
specifications from MCPHub; it never reads dashboard credentials from source
files and never stores secrets in this crate.

