# Whole-application acceptance status

The full project specifications in Basic Memory (October 22 and 23) remain the
scope. This is an evidence map, not a completion declaration. Source tests do not
prove that production deployment or real PostgreSQL acceptance has passed.

| Required area | Existing evidence | Remaining gate |
| --- | --- | --- |
| Upstream compatibility | v1.1.8 baseline; legacy routing and group tests | Final deployed configuration acceptance |
| Immutable RAW, IDs, retention, pins | Production schema initialized twice on PostgreSQL; immutable UPDATE rejection; independent state; 10,005 owner rows pruned to 10,000 plus pins, another owner preserved, expired chunks cascaded | Representative payload-size/search workload and deployed data acceptance |
| Hybrid history retrieval | Real PostgreSQL regressions plus 10k indexed rows with 1536-dimensional vectors: unique scoped hits, correct final pagination, oldest pin protected | Mixed real-payload retrieval quality and deployed data acceptance |
| Objective-aware large replies | Exact-source BM25, vector fusion, token budgets, immutable capture proof, structured outputs, JSON/diff boundaries and bounded file-header context; dispatcher tests and local 1 MB logs/JSON/diff smoke benchmark | Live vector/provider acceptance and representative workload calibration |
| Per-tool policies | Controller persistence/validation tests; actual browser add/save/remove and bounds checks | Deployed settings acceptance |
| Result Explorer | Browser timeline pagination, stale-response rejection, network recovery and exact chunk-to-RAW highlighting; source compare/chunks/metrics | Complete Smart/RAW/Chunks/Related acceptance with deployed data |
| MCP-Zero | Hierarchical retrieval, scope/fallback and RRF dedup tests; offline paired evaluation reporter with ranking metrics and measured latency/token summaries | Representative live/recorded precision/recall, cold/warm latency and token-cost benchmark |
| Model attribution | Real PostgreSQL concurrent rotation, nonce winner, call-bound proof and review concurrency tests; concurrent loopback HTTP clients with per-key/task isolation and one-time signed replay | External concurrent-client and trusted gateway deployment acceptance |
| LoopGuard / ToolPilot | Failure loops, explicit unchanged-success tools, repeat-intent exclusions, scoped feedback, bounded metadata-only provider tests; PostgreSQL branch/feedback/reaction isolation; isolated browser acceptance of unchanged-success settings and advice | Full deployed settings/detail acceptance; independently verified reactions/outcomes |
| Experience Memory | Scope/evidence tests and reviewed manual advice | Broader verified strategies and deployment acceptance; optional adapters remain optional |
| Dataset / Skills | Reviewed SFT, recorded trajectories, DPO, split registry and miner tests; PostgreSQL preview/export tenant/latest-consent gates and current independent Experience evidence | Broader deployed export/skills acceptance; no fabricated original conversation |
| Windows service / stdio | Actual isolated SCM, Job Objects, duplex streams, managed tools and interactive broker acceptance | Full installer wizard acceptance and production switch |
| Native dashboard | Actual browser same-ID service/agent restart targets, offline agent and narrow layout | Deployed package acceptance |
| Installer | Official NSIS bundle built and entry assets checked; install helper exercised in PowerShell 7 and 5.1; occupied-port preflight tested in 64/32-bit PowerShell; welcome/directory wizard pages observed | Complete installation/shortcuts/bootstrap flow and real logon/reboot |

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

On October 25, the browser exercised the actual unchanged-success settings label,
blur handler, SettingsContext updater and result advice paragraph extracted from
source into an isolated fixture. Saving trimmed nonempty server/tool lines sent
one PUT; an unchanged blur sent none; clearing sent an empty list. The success
advice explicitly avoided inferring task failure. At 540 px there was no horizontal
overflow. Translation and API responses were stubbed, so this does not establish
deployed localization, backend persistence or whole-page acceptance. The fixture
server and its browser tab were closed after verification.

The refreshed official Windows bundle contains runtime source through `746dcd2`
and the installer preflight fix from `41ee8af`. Backend build, frontend typecheck
and frontend build passed; all six current index assets occur in the generated
NSIS manifest. The 58.12 MiB installer SHA-256 is
`B0BE14F61D2C13C3CED6A5DF1F0111D6F6DA8BD5E8212CAC20F5E59A4A067472`.
Packaging success does not establish wizard or production installation acceptance.

The concurrent HTTP acceptance run
[40171211042](https://github.com/tommilevs/mcphub-crud/actions/runs/40171211042)
passes all 24 PostgreSQL integration tests. Its new loopback TCP test uses Express,
the actual attribution runtime and durable PostgreSQL context/nonce storage. Four
simultaneous starts with one model produce distinct tasks/calls; two keys for the
same username remain isolated, as does another username from the same address.
Continuation preserves context with distinct call IDs, fork preserves the task
with a new branch, and attribution fields are stripped from forwarded arguments.
Concurrent reuse of one signed invocation yields exactly one verified call, while
an unsigned continuation remains self-reported. Fixture authentication assigns
synthetic principals and the upstream handler is a stub. This does not establish
production authentication, full MCP transport or external provider integration.
