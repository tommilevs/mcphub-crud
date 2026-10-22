# Tool Result History execution ledger

- 2026-10-22 Setup: source spec restored from Basic Memory; branch `feat/tool-result-history`; upstream baseline imported from v1.1.8.
- Ruling: V1 history is PostgreSQL-only, matching existing Activity availability — avoids an unbounded local JSON blob store; cost if wrong: a file-backed adapter must be added later.
- Ruling: sensitive credential-templated calls are metadata-only — preserves existing security policy; cost if wrong: some useful outputs will require an explicit per-tool opt-in later.
