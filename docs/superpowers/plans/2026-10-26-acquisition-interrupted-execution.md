# Interrupted acquisition execution implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. No subagents are needed.

**Goal:** Expose an interrupted execution for explicit owner review without replaying installation or deleting unknown outcomes.

**Architecture:** Add a nullable heartbeat timestamp to the existing immutable execution claim. The claiming process refreshes it every 30 seconds while queued or running and confirms ownership before each side-effect phase. A dashboard administrator can atomically mark an owner-scoped operation for review only after 120 seconds without a heartbeat. This is observation and fencing, not recovery by reinstalling. The private execution token remains internal and cannot be taken over.

**Tech stack:** Existing TypeScript queue, PostgreSQL lifecycle journal, Express dashboard authentication and React panel.

- [ ] Add failing execution tests for queued keepalive, stopped timers and lost ownership before native phases; implement a small non-overlapping heartbeat helper and integrate it with the pipeline.
- [ ] Add the schema column and repository heartbeat/stale-review CAS; verify owner isolation, fresh/stale races and no replay against actual PostgreSQL.
- [ ] Add authenticated empty-body review endpoint and a stale-status/button in the existing panel; verify authorization and truthful status. No secret payload or destructive cleanup is part of this endpoint.
- [ ] Run acquisition tests, backend/frontend type checks, PostgreSQL and native acceptance as applicable; commit and checkpoint remaining cleanup and production gates.
