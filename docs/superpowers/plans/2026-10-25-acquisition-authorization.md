# Acquisition authorization and operation identity

Spec: managed MCP acquisition design, preserving existing authentication policy.
Goal: an explicit dashboard approval is bound to one immutable plan, with exactly
one durable operation even under concurrent retries. No package execution yet.

- [x] Extend schema with separate operations referencing immutable plans, unique
  plan ID and owner/idempotency key. Retain plan payload separately from state.
- [x] Repository authorization verifies owner, expiry and exact digest; insert from
  eligible plan only. Duplicate requests return the same operation, conflicting
  idempotency keys fail. Test concurrent approval in real PostgreSQL.
- [x] Annotate existing auth branches with server-derived method. Approval route
  accepts existing authenticated admin JWT/session, rejects MCP bearer, forward
  auth and skip-auth. No model `approved:true` flag establishes approval.
- [x] Add HTTP tests for route gates and missing/stale digest, run existing auth
  regression suites and typecheck, retain actual CI evidence.

This proves the request used dashboard authentication, not that a particular human
clicked a button: anyone holding a dashboard credential has that authority.
Human review UI, execution claims/state transitions, cancellation and recovery
must be implemented before calling installation complete.

Evidence: 57 local tests across six suites including existing auth/forward-auth;
backend typecheck passed. Real-PG run 40202773713/job121197255531 passed 36 tests
including five concurrent approvals producing exactly one operation. Follow-up
41d2d06 rejects another plan's reused key even when the target already has an
operation; real-PG run40202857086 also succeeded. Auth method is server-derived,
and the approval endpoint rejects bearer, forward, skip and absent methods.

Market UI now exposes a collapsible review panel to admins, using existing hub
surface/line/input tokens and compact spacing. It searches proposals, requires
an explicit target group and exact version, displays source/inputs/expiry/digest,
and requires a checkbox for the exact saved plan. Any source/version/group change
clears that plan and confirmation. Failed approval retries retain the same key.
After approval it states that execution has not started; no worker is connected.

Browser evidence: actual component + acquisitionService + fetchInterceptor/runtime
against controlled synthetic HTTP responses, with auth and translation boundaries
injected. Search -> prepare -> review -> change version -> reprepare -> initial503
-> retry passed; both requests had the same key and exact digest. Screenshots
inspected at 540 and1440px; no horizontal overflow at320/540/1440. This is not a
browser-to-PostgreSQL or production installation acceptance claim. Owned tab and
in-memory HTTP server were closed (listening=false). Production build passed;
frontend typecheck and14 targeted UI/controller tests passed.
