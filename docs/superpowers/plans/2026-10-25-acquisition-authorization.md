# Acquisition authorization and operation identity

Spec: managed MCP acquisition design, preserving existing authentication policy.
Goal: an explicit dashboard approval is bound to one immutable plan, with exactly
one durable operation even under concurrent retries. No package execution yet.

- [ ] Extend schema with separate operations referencing immutable plans, unique
  plan ID and owner/idempotency key. Retain plan payload separately from state.
- [ ] Repository authorization verifies owner, expiry and exact digest; insert from
  eligible plan only. Duplicate requests return the same operation, conflicting
  idempotency keys fail. Test concurrent approval in real PostgreSQL.
- [ ] Annotate existing auth branches with server-derived method. Approval route
  accepts existing authenticated admin JWT/session, rejects MCP bearer, forward
  auth and skip-auth. No model `approved:true` flag establishes approval.
- [ ] Add HTTP tests for route gates and missing/stale digest, run existing auth
  regression suites and typecheck, retain actual CI evidence.

This proves the request used dashboard authentication, not that a particular human
clicked a button: anyone holding a dashboard credential has that authority.
Human review UI, execution claims/state transitions, cancellation and recovery
must be implemented before calling installation complete.
