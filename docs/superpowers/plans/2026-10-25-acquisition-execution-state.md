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
