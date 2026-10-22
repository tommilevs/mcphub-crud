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
specifications from MCPHub. Secret references are sent as opaque IDs; the
service resolves them from its machine-scoped DPAPI store only when spawning a
managed process. The dashboard admin API (`/api/native-runtime/secrets/:id`)
enrolls and removes values, while `/api/native-runtime/status` reports managed
process state without returning secret material.

`runtime-core::dpapi` provides the Windows machine-scoped DPAPI
protect/unprotect primitive used by the credential broker. Native mode accepts
`nativeSecretRefs` for environment variables whose values were enrolled in the
broker. Credential-templated and personal-auth stdio configurations remain on
the existing Node-owned transport until those identity-specific flows can be
represented safely by the service.

The Tauri tray bundle contains the dashboard assets and runtime service binary.
The Node gateway remains the API process and must be started by the host
deployment. For development use `pnpm backend:dev`; for a production Node
deployment, build with `pnpm backend:build` and run `dist/index.js`. The tray
opens the gateway at `http://127.0.0.1:3000`, while the installer registers the
native service independently so managed stdio processes survive tray closure.

