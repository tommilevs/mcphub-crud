# Durable MCP acquisition plan implementation

Spec: `2026-10-25-managed-mcp-acquisition.md`.
Goal: persist an immutable owner-scoped plan before authorization or execution.
Architecture: strict catalog-to-manifest adapter and explicit PostgreSQL schema;
separate lifecycle records will follow. No install or approval side effect here.

- [x] Unit-test pinned npm manifest creation, rejection of unsupported commands,
  secret-value exclusion, stable digest and validation.
- [x] Implement manifest builder for simple catalog npx npm packages; exact semver
  is required, tags/ranges and extra shell arguments are unsupported in this slice.
- [x] Add explicit PostgreSQL schema and repository with owner-scoped reads,
  bounded expiry and immutable payload; wire schema into database initialization.
- [x] Add isolated real-PostgreSQL persistence/owner/expiry/immutability acceptance
  to existing CI, run unit/type checks, record actual CI evidence separately.

Ruling: support simple pinned npm packages first; unsupported catalog installers
remain visible as proposals but cannot become executable plans. No fake approval
endpoint is introduced: a model boolean must never count as human authorization.
HTTP plan creation and review UI follow this tested persistence boundary.

Local evidence: 9 unit/controller tests pass, backend typecheck passes; real-PG
suite skips without explicit disposable test credentials. Hosted CI result pending.
SQL trigger rejects UPDATE of the entire plan; expiry is filtered at read time.
Lifecycle/authorization records must remain separate from immutable manifest data.
