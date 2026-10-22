# Tool Result History Implementation Plan

Source of truth: Basic Memory `tommi/projects/mcphub/mcphub-smart-runtime-and-tool-result-memory-full-project-context-2026-10-22`.

## Goal

Add the first production layer of Smart Result Memory without changing existing MCP tool behavior: every eligible real tool execution receives a stable `result_id`, its full pre-compression MCP response is persisted immutably, recent unpinned history is retained at 10,000 records, and administrators can browse, search, pin, download, and inspect ranges in the dashboard.

## Invariants

- Existing direct, group, OpenAPI, and `$smart` tool calls keep their current content and error behavior.
- RAW is captured before legacy compression. Legacy lossy compression stays disabled by default.
- Stored RAW is immutable; pin/use counters are mutable state in a separate table.
- Sensitive or credential-templated calls remain metadata-only.
- History persistence failure never re-executes or fails the upstream tool call.
- PostgreSQL schema is created explicitly and is excluded from TypeORM synchronization.
- Dashboard APIs remain admin-only in V1.
- Discovery/history reads do not create history entries.

## Tasks

1. Add shared Tool Result types, explicit PostgreSQL schema bootstrap, repository, and service. Tests cover canonical RAW/hash, metadata-only policy, exact/lexical search, range validation, pinning, and deterministic retention.
2. Integrate capture at the common activity logging boundary and return additive result metadata without corrupting MCP response fields. Tests cover one record per real execution and persistence failure fallback.
3. Add admin HTTP APIs: availability/list/detail/raw/range/search/pin/unpin/stats. Controller and route tests cover validation and authorization inheritance.
4. Add the React History list/detail UI, service client, navigation, translations, raw viewer, exact search, and pin controls. Typecheck/build verifies the contract.
5. Run focused tests, complete backend/frontend builds, full suite, review the branch, fix important findings, commit, and push the feature branch.

## Later phases retained

- Hybrid vector + BM25/exact retrieval with objective, versioned chunking, error heuristics, per-tool policies, and diagnostics.
- Sessions, timeline, compare, related results, and retrieval/storage metrics.
- Windows native runtime: Tauri tray, separate Rust Windows service, IPC, SCM recovery, user-session workers, managed STDIO watchdog, Job Objects, Credential Manager/DPAPI, installer and autostart.
