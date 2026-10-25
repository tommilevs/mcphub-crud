# Acquisition execution state

Goal: one worker claims an authorized operation and records guarded transitions.
No expiry-based takeover: a stalled worker may own a live native process. Recovery
must reconcile that process and staged artifacts before another execution starts.

- [x] Add claim identity and cooperative cancellation to operations schema.
- [x] Implement atomic authorized->staging claim for an unexpired verified plan,
  compare-and-set transitions bound to claim identity, owner-scoped status lookup
  independent of plan expiry, and cancellation requests without premature success.
- [x] Test concurrent claims, stale worker rejection, cancellation and terminal
  stability in the existing isolated PostgreSQL suite; unit-test transition graph.
- [x] Wire status/cancellation API; actual native staging/install/probe/publish and
  restart reconciliation follow. Never claim installation from state tests alone.

MCP-Zero integration requirement: use hierarchical discovery evidence to seed
missing-capability proposals, preserving operation with MCP-Zero disabled. Weak
scores are not proof of absence: first distinguish offline, group-restricted and
stale-index tools. Do not disclose hidden groups or auto-install on a search miss.

Evidence: real-PG run40212702106/job121227176788 passed37tests/5suites,
including concurrent worker claims, stale identity rejection and cancellation.
Owner-scoped GET `/api/market/acquisition/operations/:id` and POST `/:id/cancel`
return status after plan expiry without exposing worker claim IDs. UI provides
manual refresh and cancellation, and distinguishes pre-execution cancellation
from active cancellation awaiting cleanup. No background status polling added.
14 targeted controller/service/UI tests and backend/frontend typechecks pass;
Vite production build passes. Actual component/service/fetch client browser fixture
passed prepare/authorize/refresh/cancel and removed the cancel action at terminal
state. Fixture had controlled HTTP responses, not a native process or real PG.
Owned tab and in-memory server closed, listening=false.

Native inspection: `native/runtime-core/src/lib.rs` already has Windows
`OwnedChild::spawn` using CREATE_NO_WINDOW, CREATE_SUSPENDED and Job Objects.
`src/services/nativeRuntimeTransport.ts` is an MCP transport, not an npm installer.
The service control boundary (`native/service/src/main.rs`) currently handles
MCP start/status/secret operations. Add a bounded one-shot installer job boundary
using OwnedChild rather than treating npm output as MCP initialization. Per-job
cancellation, durable reconciliation and bounded/redacted diagnostics still need
implementation before connecting the acquisition worker.

Native core progress: `run_owned_command` now owns one-shot Windows installer
commands through OwnedChild, with CREATE_NO_WINDOW and Job Object tree ownership.
It applies a positive timeout up to900seconds, cooperative cancellation, no restart,
null stdin/stdout/stderr, and returns only exit code/timeout/cancel outcome. The
service must still resolve a reviewed typed package request; this function is not
an HTTP or arbitrary model command endpoint. No npm package was installed.

Actual local Windows native tests: all30 passed (2 core,7 tree,6 one-shot,5 stdio,
10 service). New tests cover error exit, deadline, pre-cancel/no spawn, active
cancel, invalid timeout and successful parent exit with a detached descendant
that must also terminate. The unique PID fixture file was removed and absence
asserted. Test output did not expose synthetic stderr content.

Next: asynchronous service IPC installer job registry with per-job cancellation
and status, followed by the TypeScript worker adapter. Verify the distributed
runtime includes an actual npm CLI before constructing npm execution paths;
the managed MCP transport cannot substitute for a package installer.

Service boundary now implements `install_start/status/cancel/forget` on the
machine control connection, excluding user-agent and MCP-stream delegation.
Start accepts only operation UUID, package name and exact stable version. Runtime,
CLI and operation staging paths are resolved by the service. Jobs run asynchronously
with a bounded64-entry registry; same-ID/same-package retries reuse the entry,
identity conflicts fail, and only completed jobs can be acknowledged/forgotten.
The operation directory and marker refuse automatic replay after registry loss.
Fixed npm arguments force local `--prefix` and `--global=false`; no shell command
or arbitrary installation path comes from the request. PATH includes bundled Node.

Runtime staging now copies the selected Node toolchain's npm package and probes
its CLI using staged node.exe. Host npm source/CLI probe passed (11.17.0);
Node selection explicitly takes the first application when PATH contains multiple
Node installations, avoiding an accidental array of executable paths.
PowerShell AST passes. Full rebuilt installer packaging remains unverified for this
change; the previously accepted installer artifact does not contain these features.

Actual local native tests:32 passed, including registry retry/conflict/cancel/forget
and the pinned adapter running a synthetic npm CLI under copied Node. The fixture
verified exact args/cwd, rejected malformed packages before staging and required
reconciliation after registry loss. This did not download/install an external
package. Its unique temporary directory was deleted and absence asserted. Five
TypeScript administrative-pipe tests and backend typecheck pass. Live service IPC,
real npm installation, credentials, post-install MCP probing/publication and crash
reconciliation remain acceptance gates. Typed TypeScript control adapters are added
but acquisition execution worker integration is still pending.

TypeScript installation-phase coordinator now connects an atomic PG claim to the
typed native start/status/cancel adapters. It starts once, polls boundedly, sends
cancellation once and advances staging->starting only after a known exit0. This
does not publish tools, mark ready, or claim functional MCP verification. Failed
or cancelled installation retains staging for verified cleanup rather than
claiming rollback. Unknown/lost native responses retain the claim and persist
requires_reconciliation with a static code; they never replay start or delete
uncertain staging. The UI reports uncertainty explicitly. Guarded SQL transitions
block forward progress while reconciliation is required, allowing only failure
or verified rollback; rollback clears the flag.

Local evidence:20 targeted service/controller/UI tests and both backend/frontend
typechecks passed. New coordinator tests inject repository/native boundaries;
they do not prove a real package installation. Real-PG coverage adds owner-bound
reconciliation state, blocked forward transition, static failure reason and flag
clearance after rollback. Hosted CI result pending for this source change.
Remaining: installed package/bin resolution under the owned directory, native
MCP connection with secret references, safe functional probe, group publication
and rollback receipts, explicit execution trigger and restart reconciliation.

Installed package resolution is now available as machine-only `install_resolve`.
It requires a known successful native install outcome, then checks operation marker,
exact installed package name/version, bounded JSON metadata and an unambiguous JS
entrypoint. Canonical metadata/package/bin paths must remain under their owned
directories. It returns a native spec with restart_limit0 and package_metadata
verification, not tool readiness. Non-JS adapters and ambiguous bins fail explicitly.

`inspectAcquiredMcp` uses that spec with NativeRuntimeTransport and the actual MCP
SDK client for initialize and bounded/paginated tools/list. It accepts references
only for reviewed required input names, closes its connection in finally and
returns discovery_only. It does not infer permission to call a server's tools from
readOnlyHint, install scripts or descriptions. An authorized functional probe and
publication gate remain necessary; the coordinator is not auto-triggered yet.

Evidence:33 Windows native tests pass, including exact-version/bin resolution,
path escape and ambiguity rejection, with unique fixture cleanup asserted. Seven
TypeScript tests pass including an actual SDK client over a real named pipe with
controlled native/protocol responses; initialize/tools/list/stop observed, no
tools/call, missing configuration rejected before any connection. Backend typecheck
passes. This is not live-service or installed-package functional acceptance.
Previous source537fc44 real-PG run40214375437/job121232228511 passed38tests across
five suites, including reconciliation state blocking forward progress.

Explicit functional probe permission is now optional immutable plan data
(`probe.tool`), included in its digest. Existing plans default to discovery only.
The API/UI can request one named tool call with exactly empty arguments; the
review shows it explicitly and any edit invalidates the saved plan/checkbox.
This is a limited first probe adapter, not support for arbitrary argument-bearing
probes. Never infer safety/authorization from the server's readOnlyHint.

Inspection executes a probe only for the authenticated owner of a verifying,
uncancelled, unreconciled operation whose persisted immutable manifest/digest
exactly matches the supplied plan. An atomic probe claim prevents concurrent or
uncertain-outcome replays. The exact tool must appear in tools/list. Its result is
captured through ToolResultHistoryService without compression before returning
functional/functional_failed and result_id. Evidence attachment checks owner,
operation objective, server/tool and actual available RAW; another result cannot
replace it. RPC/persistence uncertainty retains the claim and requires review.
The native connection still closes in finally; no group publication is performed.

Evidence:21 targeted tests pass, including actual MCP SDK over the controlled
native pipe calling the authorized tool once, retaining RAW capture input under
the owner and returning only a reference, rejecting unapproved manifests/replays.
Backend/frontend typechecks and production frontend build pass. These use injected
authorization/history dependencies, not a deployed installation. Real-PG coverage
adds competing probe claims and owner-bound RAW evidence attachment; CI pending.
Next: coordinate starting->verifying and persist discovery/probe evidence, owner
credential references, staged publication/rollback receipt and full execution UI.

Verification continuation now atomically claims starting->verifying before any
MCP initialization; competing continuations cannot repeat the call. It passes the
authenticated owner to inspection and stores a one-time receipt containing only
verification level, tool names and probe result_id. SQL rechecks available owner
RAW/status/tool/objective for functional evidence, and accepts discovery_only only
when the immutable plan did not request a probe. Failed functional evidence moves
to failed; persistence or transport uncertainty retains the claim for reconciliation.
Neither success path sets ready or publishes tools. UI distinguishes completed
discovery from passed verification awaiting publication.

Local evidence:27 targeted tests and backend/frontend typechecks pass. Added PG
acceptance for competing verification continuations, unavailable evidence rejection,
receipt persistence and no receipt overwrite; current source CI pending. Prior
commitc02a602 real-PG run40215724564/job121236311791 passed39tests/5suites, including
single concurrent probe and owner-bound immutable RAW attachment.

Publication settings transaction preparation is implemented as a pure helper,
not yet a live persistence adapter. It builds one private owner-scoped native
server and an explicit verified-tools selection for the target group, with no
automatic prompt/resource exposure. Existing names, dangling references and
target aliases cause a conflict. It preserves unrelated settings and isolates its
receipt from mutable configuration references. Legacy string memberships are
normalized on publication and restored on rollback only if still unchanged.
Rollback compares current server/entry with its receipt and refuses to remove
resources edited or adopted by another group; it never restores an old global
settings snapshot. Three targeted tests and backend typecheck pass.

Persistence finding: existing JSON DAOs load/save whole settings, while DB server
creation is protected by a unique server name. Applying this helper must use an
atomic current-settings transaction or equivalent durable DB transaction, not a
sequence of stale DAO snapshots. Physical apply, operation-bound publication
reservation/receipt, runtime/index refresh and final ready gate remain pending.

`transactJsonSettings` now provides a synchronous current-document mutation,
cooperative cross-process lock, optional expected revision, repeated content check,
fsync and same-directory atomic replacement. It validates reserved Smart Routing
names, preserves the existing file on callback/conflict failure and removes its
own transaction files. It neither resets an unreadable document nor reclaims an
unknown/stale lock automatically. Errors avoid printing document content.

Evidence: five real-filesystem transaction tests plus four publication/rollback
tests pass on Windows; backend typecheck passes. Fixtures use synthetic settings,
verify unrelated data and external edit preservation, busy-lock ownership, stale
revision rejection and cleanup. Every unique temporary fixture directory was
removed and absence asserted. A rollback regression now retains object format
when users added configured memberships, avoiding a new mixed legacy array.

This adapter is not yet enabled for live publication. Legacy writers ignore its
cooperative lock, and a noncooperative writer can still race the final rename;
all relevant mutation paths must adopt a shared transaction protocol before
claiming conflict-free concurrent publication. Cache invalidation, DB-mode adapter,
durable receipt and operation saga remain integration work.
