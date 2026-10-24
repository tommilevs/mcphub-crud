# MCPHub native runtime

This workspace is the native foundation for the Windows release. `runtime-core`
supervises managed stdio MCP processes and restarts crashed children within a
bounded policy. On Windows every child is attached to a Job Object so the
service can terminate the full process tree. `service` exposes a JSON-lines
development transport on non-Windows and a named-pipe control transport on
Windows. `tray` keeps the dashboard hidden until requested, exposes
dashboard/restart/exit actions, and is packaged as an NSIS installer.

Managed Windows children start suspended and hidden. The supervisor enables
`KILL_ON_JOB_CLOSE`, assigns the child to its job, and only then resumes execution.
Containment failures terminate the new child rather than leaving an unmanaged
process. Exited parents have their remaining descendants terminated even when no
restart budget remains. Failed launch attempts consume the same bounded restart
budget as successful respawns.

Run `./native/build-windows.ps1 -Action test` for native Windows tests. These
exercise actual parent/descendant processes, stopping and dropping the supervisor,
orphan cleanup after parent exit, bounded failed respawns, MCP stdio exchange and
DPAPI round-trip. Test fixtures clean their temporary executable and processes.
This is not a substitute for installed SCM service, tray, installer and full
gateway acceptance testing.

Each process has independent stdin/stdout workers, an eight-write queue and a
256-frame event queue. Overflow fails the session rather than silently dropping
frames. The Windows control pipe uses overlapped I/O with separate operation
events, so a pending read cannot block a concurrent stream write. No child I/O
wait holds the global lifecycle mutex. A write-only notification/client response
does not establish readiness; a matching successful JSON-RPC response does.

The Node transport consumes pipe data through events and closes a timed-out
control connection, preventing a delayed reply from satisfying a later request.
New gateway transports request live streaming: stdin writes are acknowledged
without waiting for a tool response, and stdout frames arrive as independent
events. Progress, server-initiated requests/replies and cancellation therefore
flow while an earlier tool call is pending. The SDK owns response/progress
deadlines; native writes have a separate bounded deadline. Older batch clients
retain their exchange behavior (60-second default, configurable init/request
deadlines clamped to 100 ms–1 hour). A new client can negotiate back to an older
batch service without replaying start or tool calls.

Streaming connections own unique process generations, with the original server
name retained for display. Closing or losing a pipe stops that connection's
process tree and forgets its temporary status record. Another connection with the
same logical name is unaffected. A restarted/exited process closes the old stream;
the gateway must reconnect and initialize a fresh generation, rather than sending
requests to an uninitialized replacement. Old-session health cannot affect the
new generation. No in-flight tool request is replayed automatically.

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
The status payload includes `STARTING`, `RUNNING`, `UNHEALTHY`, `RESTARTING`,
`CRASH_LOOP`, and `STOPPED`; `UNHEALTHY` is set after a managed stdio read or
write fails, while restart attempts remain bounded by the process policy.
Each process also exposes `protocolReady`: it stays false while the child has
only started and becomes true after a successful MCP stdio exchange. On
Windows the status response is `{ processes, gatewayHealthy }`, where
`gatewayHealthy` is an HTTP probe of the bundled gateway `/health` endpoint;
older non-Windows development responses remain the legacy process array.
When a managed stdio read or write fails, `lastError` contains the bounded
diagnostic string until the next successful exchange or restart.

`runtime-core::dpapi` provides the Windows machine-scoped DPAPI
protect/unprotect primitive used by the credential broker. Native mode accepts
`nativeSecretRefs` for environment variables whose values were enrolled in the
broker. Credential-templated and personal-auth stdio configurations remain on
the existing Node-owned transport until those identity-specific flows can be
represented safely by the service.

The private named pipe accepts SYSTEM and elevated local Administrators only.
Interactive membership alone grants no access to process execution or secret
enrollment. The installed gateway runs under the service account and can access
the pipe; ordinary dashboard users go through the authenticated HTTP admin API.
For a separately launched development gateway with native mode enabled, run that
gateway elevated. The default Node-owned stdio transport requires no elevation.
The tray opens the HTTP dashboard and does not need direct pipe access.

The service also accepts explicit diagnostic arguments `--service-name NAME`,
`--pipe-name NAME`, `--secret-dir ABSOLUTE_PATH` and `--no-gateway`. Defaults stay
`MCPHub`, `mcphub-runtime`, the machine secret store and gateway watchdog enabled.
`--gateway-port PORT` (1–65535, default 3000) and `--data-dir ABSOLUTE_PATH`
allow a separate gateway instance with its own settings file. The service passes
its pipe name as `MCPHUB_NATIVE_PIPE`; both gateway transports and administrative
requests use that pipe. These options do not provision a separate PostgreSQL
database or isolate inherited provider configuration.
`--runtime-dir ABSOLUTE_PATH` selects an explicit bundle containing `node.exe`
and `dist/index.js`; otherwise the installed resource locations are used.
Names allow only letters, digits, dots, underscores and hyphens. These arguments
let acceptance tests use a separate SCM registration and credential directory
without touching an existing gateway or production secrets.

After building the service, run `./native/test-service-windows.ps1` from an
elevated Windows shell. It registers a unique demand-start service with gateway
launch disabled, exercises a real SDK initialize/list/call through the service,
machine-DPAPI enrollment/reference resolution/deletion, automatic child restarts
without dashboard polling and management during a silent stdio exchange. Only
synthetic fixture values are used. It verifies removal of the temporary service
and its owned test directory; existing service registrations and port 3000 are
not changed. It also force-kills the service with SCM recovery enabled, verifies
a new service PID, and checks that an intentional stop stays stopped. This test
does not prove bundled gateway, tray or installer behavior.
With freshly staged resources, `./native/test-service-windows.ps1 -WithGateway`
also starts the actual bundle on an unused local port with separate settings,
JSON storage and a synthetic test administrator configured only on the temporary
service. It checks HTTP health, login, dashboard delivery, native status through
the selected pipe and gateway termination after a hard service crash. This does
not test fresh-install password enrollment or the installer/tray UI.
Add `-WithGeneratedPassword` to verify first login using the service-generated
DPAPI credential and repeat login after SCM recovery, without a supplied password.

For a new installation without `ADMIN_PASSWORD`, the service creates a random
256-bit initial administrator password in its existing machine DPAPI secret
store and supplies it to the backend through the child environment. It is not
written to settings or printed. The installer opens a local initial-login dialog
when no bootstrap credential existed; an elevated administrator can reopen it
with `mcphub-runtime-service.exe --show-initial-password`. The dialog reads the
stored initial credential only; it does not reset an existing account and may
show an obsolete password after the user changes it. An explicit `ADMIN_PASSWORD`
continues to take precedence. DPAPI storage and directory permissions are the
same as other runtime credentials.

The Windows Tauri installer can include a self-contained gateway runtime. Run
`native/package-windows.ps1` before `cargo tauri build` to stage portable
`node.exe`, the compiled backend `dist`, frontend `frontend/dist`, and production `node_modules`. The installed
Windows service starts and watches that gateway from the machine runtime
directory, so it remains available across logoff and tray closure. A gateway
started by the service is attached to a kill-on-close Job Object before it runs;
service termination also terminates that gateway's descendants. An existing
external gateway is not adopted into this job. Core Windows tests verify both
normal owner drop and a hard-killed owner without Rust destructor execution.
The tray
reuses an already listening gateway and only starts a fallback process when
the service resources are absent. Development and host-managed deployments can
run the Node gateway separately (`pnpm backend:dev` or `pnpm backend:build`
followed by `dist/index.js`).
`native/build-windows.ps1 -Action bundle` builds the service and NSIS installer
using the configured Visual Studio/Windows SDK environment and existing staging.

