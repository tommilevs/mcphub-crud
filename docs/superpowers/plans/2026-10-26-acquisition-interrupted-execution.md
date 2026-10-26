# Interrupted acquisition execution implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. No subagents are needed.

**Goal:** Expose an interrupted execution for explicit owner review without replaying installation or deleting unknown outcomes.

**Architecture:** Add a nullable heartbeat timestamp to the existing immutable execution claim. The claiming process refreshes it every 30 seconds while queued or running and confirms ownership before each side-effect phase. A dashboard administrator can atomically mark an owner-scoped operation for review only after 120 seconds without a heartbeat. This is observation and fencing, not recovery by reinstalling. The private execution token remains internal and cannot be taken over.

**Tech stack:** Existing TypeScript queue, PostgreSQL lifecycle journal, Express dashboard authentication and React panel.

- [x] Add failing execution tests for queued keepalive, stopped timers and lost ownership before native phases; implement a small non-overlapping heartbeat helper and integrate it with the pipeline.
- [x] Add the schema column and repository heartbeat/stale-review CAS; verify owner isolation, fresh/stale races and no replay against actual PostgreSQL.
- [x] Add authenticated empty-body review endpoint and a stale-status/button in the existing panel; verify authorization and truthful status. No secret payload or destructive cleanup is part of this endpoint.
- [x] Run acquisition tests, backend/frontend type checks, PostgreSQL and native acceptance as applicable; commit and checkpoint remaining cleanup and production gates.

## Evidence

Source `cd81e99` passes 91 acquisition tests, backend and frontend type checks,
and the frontend production build. PostgreSQL run
[40278181885](https://github.com/tommilevs/mcphub-crud/actions/runs/40278181885)
passes 46 tests across five suites, including five heartbeat/review races,
legacy missing-heartbeat timestamps, ownership isolation, retained first failure
code and refusal to replay reviewed executions.

Windows run
[40278181893](https://github.com/tommilevs/mcphub-crud/actions/runs/40278181893)
passes the real JWT/PostgreSQL/native pipeline with the new heartbeat checks;
its HTTP fixture also rejects fresh and foreign review requests and prevents
execution after an interrupted job is reviewed. A browser fixture using the
actual panel and frontend service verifies one review request, status transition,
button removal, no subsequent polling and no overflow at 375 px. That browser
fixture stubs authentication and backend responses; it does not prove deployment.

Review marks uncertainty and fences further phases. It does not reclaim a lease,
restart npm, reconcile native side effects, remove staging or delete secret
references. Those remain separate explicit cleanup/recovery work. The existing
verified installer from `b3cdac9` predates this feature; no production installation
or existing scheduled task was changed.
