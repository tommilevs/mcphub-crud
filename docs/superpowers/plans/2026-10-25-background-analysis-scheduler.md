# Internal model background analysis scheduler

Status: user-requested full-application requirement, implementation pending.
This is an MCPHub subsystem, not a Codex automation or Windows scheduled task.

The configured internal model incrementally analyzes accumulated tool history:
repeated errors, useful workflows, Experience/Skill drafts and missing-capability
proposals. MCP-Zero evidence can inform discovery; baseline analysis remains
available when MCP-Zero is off. No installation follows automatically.

Expose enabled state, schedule/timezone, provider/model, token budget, batch size,
queue depth, progress, last outcome, pause/resume and manual run in the dashboard.
Default disabled until configured. Interactive requests take priority; background
work yields between bounded batches. Do not interrupt or replay in-flight external
side effects merely because a budget or scheduling window expires.

Persist owner-scoped queue items, input result IDs/revisions and analyzer version,
deduplication key, checkpoint, attempts, reserved/actual usage and next due time in
PostgreSQL. Claim jobs atomically across gateway instances. Retries are bounded;
crash recovery reconciles an uncertain provider request before replay. Record
failed/unknown usage honestly rather than inventing exact token consumption.

RAW remains immutable. Send only data permitted by existing owner/privacy policies
to the selected provider. Revalidate source availability and consent at dispatch;
retention may remove an input while queued. Derived outputs cite result IDs and
remain unapproved drafts. Training consent, skills activation and server installation
retain their separate existing review/authorization boundaries. Treat tool output
as untrusted data, never scheduler instructions or permission to execute tools.

Acceptance: restart resumes pending work without duplicate drafts; competing
workers cannot claim one job; owner isolation, consent/retention revalidation,
budget exhaustion, backoff, cancellation, foreground priority and actual provider
failure are exercised. End-to-end UI/provider/PG verification remains required.

Implement after the current native acquisition execution boundary; reuse existing
History/Experience/Skills services rather than creating a second memory system.
