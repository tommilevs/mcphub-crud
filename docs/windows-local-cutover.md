# Local Windows cutover acceptance

Status: not migrated. Keep the current gateway and scheduled tasks running until the replacement passes acceptance.

## Verified installer — October 26, 2026

The bundle from source `b3cdac9ac71b611802375cfef36c4b97aa3dad77`
passed [Windows installer acceptance](https://github.com/tommilevs/mcphub-crud/actions/runs/40267719286).
This includes 39 native tests, occupied-port preflight, the interactive installer
wizard and bootstrap dialog, installed dependency imports, dashboard close to a
retained hidden tray window, gateway login, upgrade with settings and password
retention, shortcuts, and uninstall. The dashboard is created hidden and shown
after its close handler is attached, avoiding an early-close startup race.

The [tested artifact](https://github.com/tommilevs/mcphub-crud/actions/runs/40267719286/artifacts/12627533844)
contains `MCPHub_1.1.8_x64-setup.exe` (59,353,457 bytes).
The extracted EXE SHA-256 is
`3c8fd85711dc91e21a3f7c314f7cc61c2aca9a4f11d59007510b411a57e5d53b`.
The artifact ZIP has a different SHA-256:
`f272849e76289a5e2dfaec5a096dd6ba88a22f2d860813d5081aebea9ff9bf63`.
The artifact expires on October 29 at 04:30 UTC; keep a verified installer locally.

These checks used disposable Windows machines. They do not establish migration
of this PC, its existing clients, or reboot/logon acceptance. Production cutover
was previously rejected by automatic approval review; do not repeat an equivalent
migration through another mechanism.

The NSIS directory page's **Next** button starts installation immediately; there
is no separate review page. Do not advance past it during read-only wizard checks.
Fresh installation now rejects an occupied gateway port before extracting files
or stopping runtime processes. This detects a conflict; it does not migrate the
old gateway or change its launch tasks.

## Verified inputs

- Existing settings: `C:\aitools\MCPHub\data\mcp_settings.json`. The similarly named file in its parent directory is an unused sample.
- Retain the complete settings object, including users, groups, OAuth clients, routing flags and disabled servers. Do not rebuild settings from a server-only export.
- The native service supports this existing directory through `runtime-install.ps1 -DataDirectory`; no plaintext credential copy is required.
- The existing credentials sidecar is empty. Do not infer that other configuration fields contain no credentials.
- The existing downstream group is `for-59`, ID `a34a43d9-75d8-4499-bb8f-78ae0fba8264`, exposing all tools/prompts/resources of the three enabled servers. Preserve both its ID and name so bridge clients keep their endpoint.
- Port 3000 belongs to the old gateway. Do not install the default service over it before cutover.
- October 26 read-only inventory still shows seven configured servers (three
  enabled), the same `for-59` group, no installed `MCPHub` service, and all four
  named watchdog/launcher tasks in Ready state. The configured Desktop Commander
  Node executable and absolute entrypoint both exist. No tasks were disabled.
- Native user-agent acceptance passed with the actual configured Desktop Commander entry under `C:\aitools\DesktopCommander`, Windows Computer Use GuardrailStatus, and Playwright extension browser_tabs/list. Tests removed their temporary agent and did not stop the old gateway.

## Before switching

1. Complete isolated installer acceptance, including its installed resource layout. Confirm the tray connects to the intended service/port.
2. Confirm existing clients' endpoint/group dependencies. Preserve server names and group membership; retain disabled entries.
3. Use the existing data directory in place, with one minimal rollback held in the authorized credential store if needed. Never copy the settings into Git, ordinary notes or temporary files.
4. Preserve Desktop Commander's absolute configured entry. Interactive server execution must target the actual signed-in Windows session, not a fixed guessed session ID.
5. Convert Playwright to stdio with the existing Node/CLI, working directory `C:\aitools\playwright-mcp`, extension/profile/shared-browser arguments and existing extension credential. Do not persist its token as ordinary config; provision the native credential reference before service migration.
6. Convert Windows Computer Use to its executable with `stdio --toolsets default,testing` in the intended desktop session. Preserve policy-stop semantics; never reset a guardrail to make a test pass.

## Cutover and rollback

- Stop only the old MCPHub launcher and its owned gateway immediately before binding the replacement to port 3000. Keep the old installation available for rollback.
- Register the native service with the existing data directory. Verify settings, login behavior, group endpoints and actual calls to all three migrated tools through the gateway, including Playwright's extension connection and correct Windows desktop identity.
- On failure, stop the replacement, restore the original settings through the authorized rollback, and resume the original launcher. Do not run two writers against the settings file.
- Disable/remove `MCPHub Watchdog`, `Playwright MCP Extension`, and `Windows Computer Use Watchdog` only after each corresponding replacement has passed functional acceptance.
- `Desktop Commander Remote (ChatGPT)` serves a separate remote connection. Do not remove it based on local stdio success.
- `MCPHub Bridge Watchdog` requires dependency review; preserve it until its role is resolved. Preserve the unrelated Stealth Browser task and disabled desktop-touch configuration.
- Verify logout/logon/autostart and guardrail stop behavior; report any acceptance that could not be performed. Delete only migration-owned temporary artifacts after success.
