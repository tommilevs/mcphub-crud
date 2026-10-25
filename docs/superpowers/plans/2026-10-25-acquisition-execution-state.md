# Acquisition execution state

Goal: one worker claims an authorized operation and records guarded transitions.
No expiry-based takeover: a stalled worker may own a live native process. Recovery
must reconcile that process and staged artifacts before another execution starts.

- [ ] Add claim identity and cooperative cancellation to operations schema.
- [ ] Implement atomic authorized->staging claim for an unexpired verified plan,
  compare-and-set transitions bound to claim identity, owner-scoped status lookup
  independent of plan expiry, and cancellation requests without premature success.
- [ ] Test concurrent claims, stale worker rejection, cancellation and terminal
  stability in the existing isolated PostgreSQL suite; unit-test transition graph.
- [ ] Wire status/cancellation API; actual native staging/install/probe/publish and
  restart reconciliation follow. Never claim installation from state tests alone.

MCP-Zero integration requirement: use hierarchical discovery evidence to seed
missing-capability proposals, preserving operation with MCP-Zero disabled. Weak
scores are not proof of absence: first distinguish offline, group-restricted and
stale-index tools. Do not disclose hidden groups or auto-install on a search miss.
