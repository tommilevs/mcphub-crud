# Whole-application acceptance status

The full project specifications in Basic Memory (October 22 and 23) remain the
scope. This is an evidence map, not a completion declaration. Source tests do not
prove that production deployment or real PostgreSQL acceptance has passed.

| Required area | Existing evidence | Remaining gate |
| --- | --- | --- |
| Upstream compatibility | v1.1.8 baseline; legacy routing and group tests | Final deployed configuration acceptance |
| Immutable RAW, IDs, retention, pins | Production schema initialized twice on PostgreSQL; immutable UPDATE rejection; HTTP RAW/range/admin/pin checks; 10,005 owner rows pruned to 10,000 plus pins, another owner preserved, expired chunks cascaded | Representative payload-size/search workload and deployed data acceptance |
| Hybrid history retrieval | Real PostgreSQL regressions plus 10k indexed rows with 1536-dimensional vectors: unique scoped hits, correct final pagination, oldest pin protected | Mixed real-payload retrieval quality and deployed data acceptance |
| Objective-aware large replies | Exact-source BM25, vector fusion, token budgets, immutable capture proof, structured outputs, JSON/diff boundaries and bounded file-header context; dispatcher tests and local 1 MB logs/JSON/diff smoke benchmark | Live vector/provider acceptance and representative workload calibration |
| Per-tool policies | Controller persistence/validation tests; actual browser add/save/remove and bounds checks | Deployed settings acceptance |
| Result Explorer | Browser timeline pagination, stale-response rejection, network recovery and exact chunk-to-RAW highlighting; source compare/chunks/metrics | Complete Smart/RAW/Chunks/Related acceptance with deployed data |
| MCP-Zero | Hierarchical retrieval, scope/fallback and RRF dedup tests; offline paired evaluation reporter with ranking metrics and measured latency/token summaries | Representative live/recorded precision/recall, cold/warm latency and token-cost benchmark |
| Model attribution | Real PostgreSQL concurrent rotation, nonce winner, call-bound proof and review concurrency tests; concurrent SDK clients; actual MCP route/bearer authentication binds signed evidence to its owner | External concurrent-client and trusted gateway deployment acceptance |
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

The refreshed official Windows bundle contains runtime source through `47d089d`,
the installer preflight fix from `41ee8af` and textarea CSS from `a0e9a74`.
Backend build, frontend typecheck
and frontend build passed; all six current index assets occur in the generated
NSIS manifest. The 58.13 MiB installer SHA-256 is
`06751EA5F3F3545CE80E6D9150C9E544AA6F14A457328962AA17B96D1D5BA5C3`.
Packaging success does not establish wizard or production installation acceptance.
The refreshed staged runtime passed the isolated install/login/upgrade/data
retention/uninstall lifecycle again. No temporary acceptance service remains.
WindowsSandbox.exe is absent on this host; clean full-NSIS acceptance needs a
separate Windows environment. Production gateway and launch tasks were untouched.

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

The follow-up
[40171455169](https://github.com/tommilevs/mcphub-crud/actions/runs/40171455169)
passes 25 PostgreSQL integration tests, including two real MCP SDK clients over
Streamable HTTP. SDK calls retain distinct owner/task contexts, reject another
key's trace and strip hub arguments before forwarding. An adapter inserts proof
at the client transport's send boundary using the actual JSON-RPC invocation ID;
the server passes the SDK's original request ID to the attribution runtime and
successfully verifies the proof. An unsigned continuation remains self-reported.
The SDK, TCP transport, runtime and PostgreSQL are real; authentication and the
upstream tool remain fixtures. Production routing/authentication and an external
provider adapter still require deployment acceptance.

The production-route follow-up
[40171751096](https://github.com/tommilevs/mcphub-crud/actions/runs/40171751096)
passes all 29 tests across four integration suites. Real SDK clients call the
application's MCP route, bearer-key resolution, principal runtime, attribution
wrapper and actual HTTP upstream fixture. Both signed calls assert Alice as the
proof owner; only Alice's authenticated bearer key obtains verified evidence.
Bob's ordinary public-tool call succeeds without verified provenance, and exactly
one nonce is persisted. Users, keys, settings and provider responses are synthetic;
the authentication implementation, MCP routing, upstream transport and PostgreSQL
nonce storage are real. The isolated schema is dropped and checked absent. This
closes the fixture-authentication gap for this path, while external deployment and
an adapter consuming actual provider responses remain unverified.

The History HTTP run
[40172124338](https://github.com/tommilevs/mcphub-crud/actions/runs/40172124338)
passes 30 integration tests. Application authentication and History controllers
read actual PostgreSQL records: anonymous RAW access returns 401, non-admin RAW
and pin access return 403, filtered metadata lists omit RAW, and administrator RAW
matches the retained serialized string exactly. An octet-stream range splitting
an emoji returns the original bytes with the exact Content-Range; invalid ranges
return 400, omitted payloads return 409 and an absent result returns 404. Pin and
usage updates preserve RAW and its digest. The disposable schema includes public
in its search path for the pgvector extension, and is dropped and checked absent.
These are synthetic records through real HTTP/authentication/controllers/storage,
not browser or deployed-data acceptance.

The follow-up [40172441867](https://github.com/tommilevs/mcphub-crud/actions/runs/40172441867)
also passes all 30 integration tests. Before chunk vectors exist, the HTTP search
returns lexical hits without calling the embedding provider. PostgreSQL checks
distinguish absent, lexical-only and vector-ready indexes for the exact result;
another result's vectors do not enable the request. The chunks endpoint reports
the retained version and embedding dimensions. Controller tests also verify that
hybrid search still requests an embedding when vectors are ready.

[40172626694](https://github.com/tommilevs/mcphub-crud/actions/runs/40172626694)
passes the same 30-test integration set with additional History HTTP assertions:
equal RAW digests compare equal, omitted payloads do not; comparison metadata
excludes RAW; invalid comparison sizes and non-admin requests are rejected.
Owner-filtered statistics match record/pin/payload/byte counts and expose retrieval
counters. Session and conversation timelines return both linked results without
RAW, and lineage resolves the retained parent. Browser and deployed-data
acceptance remain separate gates.

[40172946373](https://github.com/tommilevs/mcphub-crud/actions/runs/40172946373)
passes 31 integration tests, including authenticated Dataset preview/export over
HTTP against the production History schema. Missing reviews prevent export;
task consent and digest-bound privacy/quality review enable one eligible record.
Another owner's record is excluded. Wrong-digest and stale-revision reviews
return 409; revoking privacy or consent immediately removes the example from the
next preview/export. JSONL omits RAW, response/file digests match and no-store
headers are present. RAW and its digest remain unchanged. Seeded attribution and
discovery context are synthetic reviewed fixtures, not actual provider evidence.

[40173253825](https://github.com/tommilevs/mcphub-crud/actions/runs/40173253825)
passes 32 integration tests including Experience-to-Skills over authenticated HTTP.
Two independently reviewed two-step workflows support an Experience proposal;
draft Experience is not readable as approved advice or usable for a skill preview.
Separate approval enables a draft skill, whose export remains blocked until its
exact revision is approved. Editing revokes approval, stale revisions conflict,
and version history retains all four revisions. Approved download is no-store and
omits RAW. Revoking one evidence review hides the Experience and blocks an already
approved skill's next export; non-admin access and another key scope are denied.
Workflows and reviews are synthetic; no skill is installed or executed by this test.

The actual SkillProposalPanel/SkillEditor and skillService were exercised in a
browser against controlled HTTP responses. Saving sends a draft edit at revision
1; approval is a separate request at revision 2. Unsaved edits disable review,
approval and download; the saved-version list renders revisions 3/2/1. A 409
export revalidation error is shown to the user. Key scope is preserved on requests.
The export POST succeeded. Although the browser extension did not deliver its
download event, the resulting SKILL.md file was independently verified against
the saved fixture's SHA-256 and removed after verification. Translation/auth/fetch boundaries and
API responses were fixtures, not an integrated deployed backend.

This check exposed a shared textarea styling bug: `.hub-input` forced every field
to 32 px, ignoring textarea rows. Textareas now honor their row count, have vertical
padding and allow vertical resizing. With production-built CSS, the 14-row skill
editor measured about 261 px and a three-row control 77 px; ordinary inputs remain
32 px. The narrow 540 px view has no horizontal overflow. Both fixture servers and
owned tabs were closed after verification.

The actual DatasetBuilderPanel and datasetService also passed a controlled browser
check. Seed/format changes hide the previous manifest. Changing selected result
IDs during a delayed preview leaves that old response unusable for download;
the next preview/export request contains only the new IDs and current key scope.
An empty export clears the preview, shows the consent/review refresh message and
leaves preview available. There was no horizontal overflow at 540 px. API,
translation/auth boundaries and history/preference child panels were fixtures;
integrated backend and full child-panel acceptance remain open. The temporary
server and owned tab were closed, and the empty export created no download file.

The actual ExperienceMemoryPanel/ExperienceManager and experienceService passed
a controlled browser check at 540 px. Editing the title or changing selected
evidence resets approval; saving sent `approved: false` with only the new evidence
ID. Separate approval sent revision 1 and rendered approved revision 2. After the
fixture revoked evidence, refresh displayed the exclusion warning and disabled
approval. Changing key scope immediately removed the old entry; loading sent the
new key and rendered an empty scope. No horizontal overflow occurred. API and
translation/auth boundaries were fixtures, not integrated backend acceptance.
The owned tab and in-memory server were closed; no fixture files were created.

DatasetPreferencePanel and DatasetExportHistory were also exercised as actual
children of DatasetBuilderPanel with actual service modules and controlled API
responses. Creating a pair sent the chosen/rejected IDs and comparability consent;
editing its rationale cleared approval and disabled approval until saved as draft
revision 2. Separate approval sent revision 2 plus privacy/comparability consent,
then rendered approved revision 3. The DPO shortcut selected the DPO format.
An export receipt displayed split/count/bytes/hash and the correct result link.
Changing key scope immediately cleared both old receipts and pairs; subsequent
requests carried the new key and rendered empty history. No horizontal overflow
occurred. This is controlled browser evidence, not integrated backend acceptance.
The owned tab and in-memory server were closed without creating fixture files.
