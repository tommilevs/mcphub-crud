# Owned acquisition cleanup

Goal: an administrator can remove an operation's abandoned package and credential
references after a confirmed cancellation/failure or completed publication
rollback. Preserve immutable plans, RAW results and lifecycle evidence.

## Existing boundaries

`InstallerJobs::forget` acknowledges a terminal in-memory job; it does not remove
files. Registry loss currently refuses replay when staging already exists.
`stageAcquisitionPackage` records a confirmed cancelled native job as `failed`
with `cancelled_requires_cleanup`. Unknown native outcomes require reconciliation.
Publication rollback removes registration/runtime/index and retains the package.
Cleanup must not reinterpret these records as proof that files were removed.

## Contract

1. Use a separate additive cleanup journal keyed by operation ID, bound to owner
   and manifest digest. Keep the existing operation state enum and failure reason.
   Store the private cleanup claim, timestamps and per-step receipts; expose only
   public status. Existing operations without a cleanup row remain readable.
2. An authenticated dashboard administrator requests owner-scoped cleanup with an
   empty-body POST `/api/market/acquisition/operations/:id/cleanup`. Callers cannot
   supply paths, package coordinates, secret IDs, timestamps or commands. Derive
   them from the immutable manifest and operation identity. A repeated request
   observes the existing claim; it does not enqueue another worker.
3. Reject ready/running/authorized operations, unknown native outcomes and pending
   publication/activation/rollback claims. A published operation needs a completed
   rollback receipt and verified absence from runtime/index before cleanup.
4. Lock settings mutations across reference checks and native cleanup. Inspect
   every server, including disabled and differently named servers, for adoption
   of the package directory or owned native secret references. Implement the
   equivalent JSON file and PostgreSQL reservation guards before declaring both
   settings stores supported. An unsupported store must refuse cleanup explicitly.
5. A machine-only native cleanup request accepts operation ID and exact package
   identity, never a caller path. Require a confirmed terminal matching installer
   job, matching operation marker and no managed process using the package. An
   agent/stream connection cannot invoke it. Registry loss requires review.
6. Resolve the configured acquisitions root and exact UUID child, refuse root,
   siblings, marker mismatch and reparse escapes. Verify the final target before
   recursive deletion. Serialize cleanup with install/resolve/forget for that
   operation. Do not follow a junction into unrelated files.
7. Persist native cleanup intent/receipt outside the directory being removed.
   If a reply is lost or the service restarts mid-delete, do not infer completion
   from a missing directory or replay installation. Return recorded completion
   only when a completed receipt proves it; otherwise require review.
8. Delete only deterministic credential IDs for this owner/operation/manifest,
   under the same adoption guard. Journal each confirmed outcome. Mark cleanup
   complete only after package and credential deletion are confirmed. A partial
   failure remains visibly incomplete; it must not erase the original failure.
9. The UI presents what cleanup removes, starts one explicit request, shows
   progress/review/completion and never claims that RAW results were deleted.

## Implementation and verification

- [x] Add journal migration/repository with owner isolation, atomic claims and
  completion receipts; PostgreSQL concurrency tests must prove only one worker.
- [ ] Add native ownership/path/terminal-job guards and durable receipt handling.
  Test wrong identity, active jobs, registry loss, junctions, partial deletion and
  lost responses using owned temporary fixtures only.
- [ ] Add JSON/PostgreSQL adoption guards and the coordinator. Test settings
  mutation races, renamed/disabled adoption, runtime/index references and partial
  secret deletion. Never call destructive phases after a failed prerequisite.
- [ ] Add authenticated API and dashboard status. Test foreign owners, bearer-only
  management requests, invalid bodies, duplicate requests and truthful failures.
- [ ] Extend real Windows npm cancellation acceptance through explicit cleanup;
  assert the exact owned directory/credential are absent, unrelated fixtures and
  RAW remain, and repeated execution cannot reinstall the package.
- [ ] Extend publication rollback acceptance through cleanup and verify the same
  invariants for both settings stores. Release only with matching evidence.

This plan authorizes no deletion on the user's installed system. Development
fixtures must prove the contract before a cleanup action is offered there.

Journal source `feb6631` passed real PostgreSQL run `40305423287`, job
`121513215713` (49 tests across six suites, logs read). New tests cover eight
concurrent claims, owner/FK isolation, step ordering, eligibility exclusions,
partial review fencing and preservation of the original operation failure.
Read-only native ownership preflight `c77d8dd` passed Windows run `40306912393`,
job `121518171775`: inspection refuses a running installer and wrong package
identity, then accepts the exact cancelled job without removing its directory.
It also rejects nested junctions in the native fixtures.

Settings reference guards `2e304c4` passed PostgreSQL run `40309403737`, job
`121526519294` (50 tests across six suites, logs read). Disabled/renamed adoption
prevents work; a real concurrent server UPDATE times out while guarded work is
pending. JSON uses the existing settings file lock across asynchronous work.
Local fixtures prove real Windows junction aliases are detected and unrelated
target contents survive. The guard includes operation/secret references and
canonical absolute paths plus relative arguments under the configured working
directory. Unreadable or stalled lookups refuse cleanup with static errors.

Native durable receipt primitives are present in `b3a8b2c`, but are not wired to
deletion. Native launch-reference preflight in `bfe823f` inspects the service
supervisor under its mutex, including restartable exited definitions. Personal
and interactive supervisors still require lifecycle/reference coordination.

Personal-runtime tracking now retains immutable internal launch snapshots before
connect and after cache invalidation. A cleanup reservation blocks new starts
and invalidates preparations from earlier generations. Only an explicit native
job-tree exit receipt releases a retired reference; legacy, failed and unknown
outcomes remain references. Identical uncertain attempts are compacted without
letting a later successful stop erase an earlier uncertain launch. This is an
internal guard. Shared and per-session transport factories now reserve immutable
launch snapshots before connect, preserve runtime-only argument bindings, and
retain started legacy transports after close when no native exit proof exists.
Never-started transports can release their reservation but cannot be restarted.
The combined internal guard fences shared and personal launches and checks the
retained server catalogue. Interactive coordination and reconciliation of unknown
outcomes must still be completed before deletion is exposed.

The index guard holds a SERIALIZABLE transaction and a write-excluding table
lock throughout guarded work. It checks server metadata and server/tool content
IDs, including older tool rows without server metadata. Missing/unreadable
indexes fail closed. The PostgreSQL fixture proves remaining rows block work
and a concurrent INSERT times out until the guard releases its lock; the owned
schema is removed and its absence checked. Embedding work must drain before
acquiring this guard to avoid queue deadlocks.

These are prerequisites. There is still no cleanup actuator or public endpoint;
complete runtime coordination and the coordinator remain. No guard by itself
authorizes file or credential deletion.

### Exit proof correction

A real Windows regression with `WaitForSingleObject(handle, 0)` demonstrated
that `ActiveProcesses == 0` is weaker than signaled process handles. The native
host now captures member handles before termination, verifies membership, waits
within one deadline, and compares retained handles with the job's total process
count. Missing early or concurrent members return `processExitConfirmed: false`;
normal execution/stop results remain usable but cannot authorize cleanup.
The installer terminal guard requires explicit true, including successful exits.
Legacy states without the field require review. Errors never acquire proof.
An already-exited short-lived child is covered by a separate real-process test.

This conservative inventory does not yet retain every handle throughout a job's
lifetime. Packages with earlier short-lived children may therefore require review;
continuous inventory/reconciliation remains necessary before cleanup release.
Interactive guard coordination, destructive actuator and full acceptance remain
unfinished. No installed service changes accompany this source work.

Win32 references: [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[TerminateProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess).

Credential cleanup journal now stores an idempotent private receipt per reviewed
input, with the same deterministic native vault ID used at installation. Owner,
claim, manifest membership and file-removal prerequisites are checked atomically.
Completion requires receipts for exactly all reviewed inputs; partial or duplicate
receipts cannot complete the operation. Public journal reads omit the receipt map.
The additive JSONB column migration preserves older completed rows; real PostgreSQL
fixtures verify the upgrade and owner/claim isolation. No vault deletion or cleanup
endpoint is activated by this journal work.

Internal cleanup coordinator is implemented with mandatory injected adapters; it
is not wired to production or a public API. It checks immutable manifest integrity,
derives native identities and vault IDs, drains index work before locks, and nests
settings/runtime/index/native reservations around all destructive phases. Exact
native completion identity precedes the file receipt; each acknowledged vault
delete precedes its own credential receipt. Overall completion follows successful
reservation release. Lost claims, mismatched receipts, partial deletion or unknown
outcomes preserve evidence and request review without automatic replay.
Real PostgreSQL fixtures exercise complete/partial outcomes with actual settings
and index reservations and journal storage; native effects are explicitly fixtures.
Native cross-session reservation/deletion adapters remain the next implementation
boundary. These coordinator tests do not prove real Windows package deletion.

Native cleanup preflight now carries explicit processExitConfirmed. The coordinator refuses missing or false proof, so an older host's weaker preflight cannot authorize effects. Actual destructive adapters remain disabled.

Installer CI a68d4da exposed the same signal race in ordinary RuntimeSupervisor::stop (job_tree descendant handle not signaled on return). All stop/restart callers now share stop_with_confirmation's retained-handle wait; the weaker accounting-only helper was removed. Missing historical inventory still returns false proof rather than authorizing cleanup.

### Handle-pinned deletion primitive

`LockedCleanupTree` captures ordinary filesystem handles from the volume root
through the exact operation tree, disallowing delete/rename sharing and writers
for captured entries. It refuses reparse points in ancestors and descendants,
checks the pinned operation marker and bounded tree before mutation, then removes
children before parents with FileDispositionInfo on those same handles. Every
removal is checked after handle close. A late child makes directory deletion fail;
its presence cannot produce a completed receipt or redirect deletion elsewhere.
Removal requires a persisted CleanupReceipt matching the data directory and exact
operation/package/version, verifies intent before mutation, and records completion
only after all captured entries are confirmed absent. Failed/partial work leaves
intent incomplete. Four actual Windows filesystem tests cover identity locks,
foreign receipts, late files, existing/late junctions, preserved unrelated files
and receipt outcomes; all newly owned fixtures are removed and absence asserted.

This is an internal filesystem primitive, not a public cleanup capability. The
machine/interactive supervisor reservation and installer-job adapter are still
required before exposing it through IPC or the dashboard. No installed data is
changed by these tests.

Win32 contracts: [CreateFileW sharing and OPEN_REPARSE_POINT](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
[SetFileInformationByHandle / FileDispositionInfo](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle).

The internal machine cleanup adapter now holds the machine supervisor mutex and
installer lifecycle/registry/outcome reservation across path capture, launch-ref
checks, durable intent, deletion and completion. A negative/missing native job
proof prevents all destructive work. Installer staging and forget share the
lifecycle reservation so their filesystem preparation cannot race cleanup.
Pinned npm start refuses any persisted cleanup intent/completion after registry
loss, preventing package-script replay after successful deletion. Actual owned
filesystem fixtures cover this replay fence and failed-proof refusal; terminal
job records in these adapter fixtures are explicitly synthetic (the separate
one-shot suites test real process proof). The adapter is still internal and cannot
be exposed through IPC until all interactive supervisors are reserved too.

The cross-session prerequisite now includes bounded native named-pipe discovery
for all `mcphub-user-*` names, including custom agent names. It neither connects
to nor controls an agent. Results are untrusted, sorted and deduplicated; scan
errors, unsupported names and bounds fail closed. Actual Windows create/close
tests prove discovery and absence after the owned pipe handle closes. The pipe
namespace reports ERROR_NO_MORE_FILES on an empty initial search, which is
handled alongside ERROR_FILE_NOT_FOUND. Search handles use FindClose.

Discovery remains internal and is NOT an exhaustive reservation: a global launch
barrier, authenticated same-handle agent connections and supervisor locks must
cover discovery through deletion before the cleanup actuator can be enabled.
Ruling: inventory includes custom pipe names rather than guessing session IDs
from names; session and executable ownership must be checked on the opened pipe.

`interactive::connect_discovered` now derives the actual session from the server
PID on a single opened pipe and reuses delegation's logged-on-user SID and exact
canonical executable checks. Explicit delegation still rejects a different
session; discovery rejects session zero. Successful validation returns that same
pipe handle, never a reopened pipe name. Real local pipe tests prove mismatched
sessions are refused; malformed discovery names fail before opening. Positive
WTS user-token validation still needs the isolated LocalSystem CI scenario.
This adapter is internal; no cleanup command or public API has been enabled.
