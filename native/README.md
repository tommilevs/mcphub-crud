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

`native/test-installer-runtime-windows.ps1` exercises the installer's actual
`windows/runtime-install.ps1` lifecycle in a unique directory containing spaces,
with a separate service, pipe, gateway port and data directory. It checks fresh
installation/login, stopping the old installed user agent before replacing its
executable, preserving another installation's agent, in-place SCM update,
existing settings and initial-password retention, and uninstall without deleting
user data. The NSIS hooks invoke that script and abort on an unsuccessful exit.
This functional lifecycle test does not exercise the complete NSIS wizard,
bootstrap-password dialog, shortcuts or per-user tray autostart UI.
The script also runs under 32-bit Windows PowerShell 5.1, as used by a 32-bit
installer on 64-bit Windows. Process identity checks use CIM with a held process
handle rather than cross-architecture `MainModule` inspection.

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
SCM confirms that no MCPHub service is registered. An installed service that is
starting, stopped or inaccessible never causes a second user-profile gateway.
The desktop window loads the service dashboard at `http://127.0.0.1:3000`, so
runtime configuration and API requests share its origin. Closing that window
hides it; Exit tray remains the explicit tray exit action.
Service restart runs outside the UI thread, waits up to 30 seconds for Stopped
before starting, and then waits for Running. The menu shows an in-progress or
failure state; Windows service-control permissions still apply.
`MCPHUB_DESKTOP_PORT` selects another loopback gateway port (default 3000);
`--open-dashboard` opens the window immediately. The webview is created with
that endpoint before navigation, so isolated tests do not contact port 3000.
`native/test-service-windows.ps1 -WithDesktop` runs the gateway fixture and
desktop on the same temporary port, then waits for interactive checks of closing
the window and Exit tray while verifying the gateway remains available.
Before Exit, also check Open Dashboard reopens the same test endpoint. When the
MCPHub autostart entry was initially absent, toggle Start MCPHub with Windows on
and off and verify the Run entry contains the exact quoted tray executable,
then becomes absent again. The native menu toggles its check state before the
callback; persistence must use that state directly and roll it back on failure.
The harness removes a newly created autostart entry only when it points to its
exact test executable, leaving pre-existing or unrelated entries untouched.
New service settings advertise their configured port; existing settings are
preserved and can be edited in the dashboard.

The service executes MCP children in its own Windows session (normally SYSTEM
Session 0). This is suitable for background tools, but does not provide access to
the signed-in user's desktop. The same executable supports a manual user-session
host: `mcphub-runtime-service.exe --user-agent`. It rejects Session 0, uses
`mcphub-user-session-<sessionId>` by default, and accepts a separate
`--pipe-name mcphub-user-...` for isolated instances. That pipe grants access to
its creating user, SYSTEM and elevated administrators. It runs the existing
streaming supervisor in the user's session, with no gateway or machine secret
store; credential enrollment, deletion and unresolved secret references fail.
The tray launches the agent silently and supervises its pipe while the tray is
running (up to five launch attempts). It reuses an existing host in the same
Windows session only after checking the pipe server's process token user SID
and executable path against the current user and installed runtime. Failure to
inspect either identity stops reuse. Closing the tray leaves the agent independent; reopening the
tray resumes monitoring. `MCPHUB_USER_AGENT_PIPE` can select a separate
`mcphub-user-...` pipe for isolated testing.
Run `native/test-user-agent-windows.ps1` to verify real SDK calls, child session
identity, connection cleanup, crash supervision, agent reuse and survival after
the tray watchdog stops.

Per-server `options.nativeExecution` selects `{ "kind": "interactive", "sessionId": 1 }`
for desktop tools. Set the actual Windows session ID explicitly; there is no
automatic selection between signed-in users. Omit the option to preserve existing
service hosting. Optional `pipeName` supports a separate `mcphub-user-...` instance.
The gateway requires Windows native hosting to be enabled and a compatible stdio
configuration; an unavailable user agent never falls back to Session 0.
The machine service opens the agent pipe once, validates its process session,
executable path and token user against the session's WTS user token, then resolves
`nativeSecretRefs` and forwards the streaming connection over that same handle.
The agent never reads the machine DPAPI store. The broker requires the installed
LocalSystem service; a standalone elevated gateway cannot replace WTS token access.
Interactive children inherit the user agent's environment. The gateway forwards
only explicit server environment entries and configured installation registry
overrides, rather than its complete SYSTEM environment. An explicit per-server
PATH is preserved. Existing service hosting keeps its previous environment behavior.
Optional `options.nativeWorkingDirectory` sets an absolute Windows working
directory for either hosting context. Omission preserves the host's inherited
directory. Relative paths are rejected by the API and runtime; older runtimes
must advertise working-directory support before the transport sends start,
so a configured directory is never silently ignored. The UI preserves this
option inside the existing options JSON storage, without a schema migration.
Disconnect closes the remote process lease. Service status lists service processes.
Administrators can explicitly target that agent through the machine broker:
`GET /api/native-runtime/status?sessionId=7&pipeName=mcphub-user-session-7`
and `POST /api/native-runtime/processes/:id/restart` with
`{"executionContext":{"kind":"interactive","sessionId":7,"pipeName":"mcphub-user-session-7"}}`.
Use the actual signed-in Windows session and configured agent pipe; `pipeName`
is optional when using the default session pipe. Omitting the target preserves
service-only behavior. The broker validates the connected agent's session,
user and executable exactly as for a streaming start, and never falls back to
Session 0. Secret administration and shutdown cannot be delegated. Restarting
a live MCP process interrupts its connection; the client must reconnect and
initialize again.

The dashboard requests `GET /api/native-runtime/status?includeInteractive=true`
to combine service processes with agents referenced by configured stdio servers.
Equivalent session/pipe targets are queried once, with at most four concurrent
connections. Each process row includes its `executionContext`; Restart sends
that exact target, so identical process IDs in different sessions stay separate.
Unreachable agents appear as unavailable without hiding healthy service rows.
This is configuration-scoped discovery, not enumeration of all Windows sessions.
The default status API remains service-only for existing clients.

`native/test-managed-tools-windows.ps1 -ComputerUseExecutable <installed-exe>
-DesktopCommanderEntry <installed-index.js>` checks real installed desktop-tool
servers through a separate native user agent: initialize, tools/list,
Windows `GuardrailStatus` (same device and admission, without resetting policy),
and Desktop Commander `get_config`. It uses the Windows server's
`stdio --toolsets default,testing` mode, does not capture/control the desktop,
and removes only its temporary host. Existing gateways and scheduled tasks stay running.
The first user-agent pipe instance is exclusive: a duplicate agent using that
pipe fails without replacing the original host. For service/agent-only changes,
`native/build-windows.ps1 -Action service` builds that executable without
rebuilding the tray or repacking the installer.
The installer requests service shutdown before replacing runtime files and
aborts that upgrade if shutdown fails. Development and host-managed deployments can
run the Node gateway separately (`pnpm backend:dev` or `pnpm backend:build`
followed by `dist/index.js`).
`native/build-windows.ps1 -Action bundle` builds the service and NSIS installer
using the configured Visual Studio/Windows SDK environment and existing staging.


Installer upgrades preserve the registered data directory, gateway port, pipe name and runtime directory when those parameters are omitted. Explicit lifecycle arguments still override the existing registration. The acceptance test upgrades with only the install directory and isolated service name to exercise the same defaulting behavior as NSIS.

