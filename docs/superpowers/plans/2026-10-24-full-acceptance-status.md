# Whole-application acceptance status

The full project specifications in Basic Memory (October 22 and 23) remain the
scope. This is an evidence map, not a completion declaration. Source tests do not
prove that production deployment or real PostgreSQL acceptance has passed.

| Required area | Existing evidence | Remaining gate |
| --- | --- | --- |
| Upstream compatibility | v1.1.8 baseline; legacy routing and group tests | Final deployed configuration acceptance |
| Immutable RAW, IDs, retention, pins | History/coordinator/repository tests; agent memory dispatch tests | Real PostgreSQL retention and approximately 10k-result workload |
| Hybrid history retrieval | Real PostgreSQL 17 CI passes five regressions at `b8ffa2b`: unique results, owner-before-limit, key/server scope, dimension mismatch, atomic index rollback | Approximately 10k-result workload and deployed data acceptance |
| Objective-aware large replies | Exact-source BM25, vector fusion, token budgets, capture proof, dispatcher tests; local 1 MB logs/JSON/diff smoke benchmark | Live vector/provider acceptance, representative workload calibration and richer structural chunking |
| Per-tool policies | Controller persistence/validation tests; actual browser add/save/remove and bounds checks | Deployed settings acceptance |
| Result Explorer | Browser timeline pagination, stale-response rejection, network recovery; source compare/chunks/metrics | Complete Smart/RAW/Chunks/Related and chunk-to-RAW navigation audit |
| MCP-Zero | Hierarchical retrieval, scope/fallback and RRF dedup tests | Precision/recall, cold/warm latency and token-cost benchmark |
| Model attribution | Handshake/context/runtime/gateway/call tests; PostgreSQL integration fixture | Real concurrent-client and trusted gateway deployment acceptance |
| LoopGuard / ToolPilot | Failure loops, repeat-intent exclusions, scoped feedback, bounded metadata-only provider tests | Unchanged successful-state signal; independently verified reactions/outcomes |
| Experience Memory | Scope/evidence tests and reviewed manual advice | Broader verified strategies and deployment acceptance; optional adapters remain optional |
| Dataset / Skills | Reviewed SFT, recorded trajectories, DPO, split registry and miner tests | Real PostgreSQL export/revocation/isolation acceptance; no fabricated original conversation |
| Windows service / stdio | Actual isolated SCM, Job Objects, duplex streams, managed tools and interactive broker acceptance | Full installer wizard acceptance and production switch |
| Native dashboard | Actual browser same-ID service/agent restart targets, offline agent and narrow layout | Deployed package acceptance |
| Installer | Official NSIS bundle built and entry assets checked; install helper exercised in PowerShell 7 and 5.1 | Wizard/shortcuts/bootstrap flow and real logon/reboot |

PostgreSQL query regressions now run in disposable pgvector CI, without needing
the production administrator credential. The red run was
[40132171539](https://github.com/tommilevs/mcphub-crud/actions/runs/40132171539);
the five-test green run was
[40132321341](https://github.com/tommilevs/mcphub-crud/actions/runs/40132321341).
This proves the tested database behavior, not a production deployment.

Current external constraints: the saved production PostgreSQL credential was
rejected; do not retry it without new information. Production cutover was rejected
by automatic approval review; do not repackage an equivalent migration attempt.
These constraints do not prevent independent source work. Keep the entire goal
active until all required acceptance gates have authoritative evidence.
