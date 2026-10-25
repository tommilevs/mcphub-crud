# Acquisition proposals implementation plan

Goal: expose read-only catalog suggestions as the first slice of managed MCP acquisition.
Spec: `2026-10-25-managed-mcp-acquisition.md`.
Architecture: pure deterministic candidate selection, existing catalog/config adapters,
authenticated admin HTTP endpoint; later management MCP tools reuse this boundary.
Tech stack: TypeScript, Express, Jest. No new dependency or schema migration.

- [x] Test ranking, unrelated queries, configured/disabled duplicate exclusion,
  bounded input/output, metadata-only responses and no installation side effects.
- [x] Implement `src/services/mcpAcquisitionService.ts`: objective tokens matched
  against catalog/tool descriptions; stable ranked candidates with explicit unverified
  provenance, required credential names and installation types, never command/env values.
- [x] Add POST `/market/acquisition/proposals` behind existing admin middleware;
  read complete configured names internally only to exclude duplicates.
- [x] Test actual HTTP handler validation and response; run targeted suites and
  backend typecheck, inspect diff, save exact progress in Basic Memory.

Ruling: endpoint is admin-only because installation planning spans configured servers;
normal Smart Routing stays unchanged until actor-scoped MCP management is implemented.
This slice neither proves missing capability nor installs anything. Catalog matching
quality and alias/package-level duplicate detection remain follow-up acceptance gates.

Evidence: targeted Jest service/controller suites (7 tests), actual Express HTTP
via supertest with injected config/catalog and the shared admin gate; backend
tsc --noEmit. This is not deployed authentication or full acquisition acceptance.
Required argument names are called `requiredInputs`, since catalog arguments may
be ordinary configuration rather than credentials. Values are never returned.
