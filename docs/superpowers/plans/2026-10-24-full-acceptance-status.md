# Whole-application acceptance status

The full project specifications in Basic Memory (October 22 and 23) remain the
scope. This is an evidence map, not a completion declaration. Source tests do not
prove that production deployment or real PostgreSQL acceptance has passed.

| Required area | Existing evidence | Remaining gate |
| --- | --- | --- |
| Upstream compatibility | v1.1.8 baseline; legacy routing and group tests | Final deployed configuration acceptance |
| Immutable RAW, IDs, retention, pins | Production schema initialized twice on PostgreSQL; immutable UPDATE rejection; independent state; 10,005 owner rows pruned to 10,000 plus pins, another owner preserved, expired chunks cascaded | Representative payload-size/search workload and deployed data acceptance |
| Hybrid history retrieval | Real PostgreSQL regressions plus 10k indexed rows with 1536-dimensional vectors: unique scoped hits, correct final pagination, oldest pin protected | Mixed real-payload retrieval quality and deployed data acceptance |
| Objective-aware large replies | Exact-source BM25, vector fusion, token budgets, capture proof, dispatcher tests; local 1 MB logs/JSON/diff smoke benchmark | Live vector/provider acceptance, representative workload calibration and richer structural chunking |
| Per-tool policies | Controller persistence/validation tests; actual browser add/save/remove and bounds checks | Deployed settings acceptance |
| Result Explorer | Browser timeline pagination, stale-response rejection, network recovery and exact chunk-to-RAW highlighting; source compare/chunks/metrics | Complete Smart/RAW/Chunks/Related acceptance with deployed data |
| MCP-Zero | Hierarchical retrieval, scope/fallback and RRF dedup tests | Precision/recall, cold/warm latency and token-cost benchmark |
| Model attribution | Real PostgreSQL concurrent rotation, nonce winner, call-bound proof and review concurrency tests | Real concurrent-client and trusted gateway deployment acceptance |
| LoopGuard / ToolPilot | Failure loops, explicit unchanged-success tools, repeat-intent exclusions, scoped feedback, bounded metadata-only provider tests; PostgreSQL branch/feedback/reaction isolation | New unchanged-success UI acceptance; independently verified reactions/outcomes |
| Experience Memory | Scope/evidence tests and reviewed manual advice | Broader verified strategies and deployment acceptance; optional adapters remain optional |
| Dataset / Skills | Reviewed SFT, recorded trajectories, DPO, split registry and miner tests; PostgreSQL preview/export tenant/latest-consent gates and current independent Experience evidence | Broader deployed export/skills acceptance; no fabricated original conversation |
| Windows service / stdio | Actual isolated SCM, Job Objects, duplex streams, managed tools and interactive broker acceptance | Full installer wizard acceptance and production switch |
| Native dashboard | Actual browser same-ID service/agent restart targets, offline agent and narrow layout | Deployed package acceptance |
| Installer | Official NSIS bundle built and entry assets checked; install helper exercised in PowerShell 7 and 5.1 | Wizard/shortcuts/bootstrap flow and real logon/reboot |

PostgreSQL query regressions now run in disposable pgvector CI, without needing
the production administrator credential. The red run was
[40132171539](https://github.com/tommilevs/mcphub-crud/actions/runs/40132171539);
the five-test green run was
[40132321341](https://github.com/tommilevs/mcphub-crud/actions/runs/40132321341).
This proves the tested database behavior, not a production deployment.
The extended run
[40132651004](https://github.com/tommilevs/mcphub-crud/actions/runs/40132651004)
passes 23 tests across history search, production schema/10k retention and
attribution/review/dataset/experience integration. The 10k test took 330 ms,
including fixture insertion and assertions; its timed retention/check section
reported 20 ms. These synthetic measurements are not production guarantees.

The stronger follow-up
[40133128337](https://github.com/tommilevs/mcphub-crud/actions/runs/40133128337)
also passes all 23 tests. It seeds 10,005 indexed owner rows, retains 10,000 plus a
pinned row dated 2000, preserves another owner and verifies the final history page.
Its 1536-dimensional hybrid query returned 20 distinct scoped hits in 130 ms;
retention/checks took 19 ms. Text and vectors are deliberately synthetic and
repeated, so these figures do not establish real-world relevance quality or
embedding-provider latency. No cloud embedding requests were made.

Current external constraints: the saved production PostgreSQL credential was
rejected; do not retry it without new information. Production cutover was rejected
by automatic approval review; do not repackage an equivalent migration attempt.
These constraints do not prevent independent source work. Keep the entire goal
active until all required acceptance gates have authoritative evidence.
