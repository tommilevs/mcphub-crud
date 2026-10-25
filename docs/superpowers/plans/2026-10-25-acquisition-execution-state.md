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
It applies a 1..900-second bounded timeout, cooperative cancellation, no restart,
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
