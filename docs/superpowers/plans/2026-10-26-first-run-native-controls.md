# First-run and native control corrections

## User observations and implementation

- The installed `b3cdac9` login message box did not provide a selectable password
  or a copy button. Source `05cde03` replaces it with a standard Win32 dialog:
  readonly selectable edit, Copy password and OK. Copy is explicit, writes only
  the password to the Unicode clipboard and reports success/failure in the dialog.
  Password loading remains read-only from DPAPI; no plaintext file is created.
- The tray exposed Restart but no Stop. Source `035913b` adds Start and Stop,
  waits for SCM state transitions, and disables all three controls while an
  operation runs. Repeated Start/Stop is idempotent. Exit tray remains separate.
- After the user's reboot, the installed service, tray and user agent were all
  present in the expected sessions, but the three enabled MCP connections
  retained file-not-found errors. Reloading each connection restored 3/3 healthy
  servers. Source `035913b` retries disconnected interactive native transports
  every 15 seconds without pinging connected stdio servers. It preserves explicit
  session binding and skips on-demand transports and disabled/connecting entries.

## Verified

- `035913b`: 12 keep-alive tests and backend type check passed; regression failed
  before implementation. Seven standalone tray control tests and the native
  service/Tauri build check passed. The optional real-SCM test had no fixture
  configured locally, so this does not prove real Start/Stop clicks.
- `05cde03`: 41 native tests passed locally, including creation of a real hidden
  Win32 dialog, correct password field contents, readonly style and Copy label.
  One clipboard interaction test is intentionally ignored locally; the Windows
  CI test action explicitly runs it on the disposable runner. This test invokes
  the actual dialog command and verifies exact clipboard contents, then clears it.
- Cancellation acceptance source `9fa38f8`, run `40301174778`, job `121499152762`:
  both full Windows pipeline and in-flight npm cancellation passed. Logs read.

## Pending release gates

Additional acceptance: Windows run `40303969719`, job `121508390824`, passed the
real SCM control fixture (logs read): Stop twice, Start twice and Restart all
reached the expected states. This exercises the functions used by the tray,
not clicks on the native context menu.

The local isolated user-agent harness also passed five SDK integration tests
and three lifecycle tests. Its new late-agent test first observes a failed real
pipe connection, starts a temporary user agent, then waits for the production
keep-alive callback to establish a real SDK connection and list tools without
manual reload. It uses the installed runtime binary and a unique direct agent
pipe, not the production service connection or a full reboot. Temporary agents
and test binaries were removed; the running production service was untouched.

- Installer `05cde03` run `40303514621`, job `121506877900`, completed successfully;
  logs confirm the actual copy-button clipboard test, interactive wizard, tray
  close behavior, bootstrap login, upgrade/data retention and uninstall. Its
  artifact is `12642007554`; ZIP SHA256 is
  `5f7cf971ade24f4f4717993d78b798dbd41b9aa275ae7a08444f18dbb741e6a1`.
  The extracted installer SHA256 is
  `1ba5642ae5abdbe0cf7b36132cbfb03f1db336810958b14c521daee49fcf193c`.
- Exercise clicks on real tray Start/Stop controls and the full installed service
  delegation path when the user agent appears after the first connection attempt.
- Validate a changed Windows logon session separately: reconnect retries do not
  authorize or automatically retarget another session.
- Deploy a verified update before claiming these corrections exist in the user's
  installed application. Existing installation is still `b3cdac9`.
