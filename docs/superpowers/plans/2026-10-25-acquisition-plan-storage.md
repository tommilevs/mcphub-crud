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

Local evidence: 12 unit/controller tests pass, backend typecheck passes; real-PG
suite skips without explicit disposable test credentials. Hosted run 40202273180 /
job 121195762241 passed all 35 tests in five real-PG suites, including three plan
storage tests (persistence/owner isolation/update rejection, expiry, digest mismatch).
SQL trigger rejects UPDATE of the entire plan; expiry is filtered at read time.
Lifecycle/authorization records must remain separate from immutable manifest data.

Admin API: POST `/api/market/acquisition/plans` accepts catalog `serverName`, exact
stable release `version` and existing `targetGroup` ID. Owner comes exclusively
from the authenticated user. GET `/api/market/acquisition/plans/:id` returns only
the same owner's unexpired plan. Responses remain `proposed` / `catalog_only`:
neither a body field `approved` nor plan creation grants installation permission.
Unit HTTP fixtures inject identities/config/storage; deployed identity acceptance
and the user confirmation UI remain pending. Database absence yields 503.
