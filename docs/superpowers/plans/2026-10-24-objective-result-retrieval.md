# Objective-aware original result retrieval

Source: the full MCPHub project specifications in Basic Memory dated October 22
and 23. An objective must affect large-result retrieval, not only history metadata.

1. Add a pure lexical candidate selector: BM25, identifier-preserving tokenization,
   bounded original windows, diagnostic boost, exact source offsets. No cloud calls.
2. Add opt-in `smart` execution settings to `call_tool`. Keep existing defaults and
   legacy compression behavior unchanged when omitted. Validate before execution.
3. Persist immutable RAW first. Transform a response only when it has a saved
   result ID, a nonempty objective, a sufficiently large payload and useful hits.
   Return original text with block/offset references and a bounded token budget.
   Keep error status and result ID. Do not claim that fragments are the full RAW.
4. Fuse lexical candidates with existing semantic candidates where available,
   without losing exact identifiers or requiring the embedding provider. Apply
   per-tool policies and keep passthrough for protected tools.
5. Verify the actual Smart dispatcher, untouched RAW, failed persistence,
   provider failure, Unicode and diagnostic tails; benchmark representative large
   outputs before choosing production thresholds.

Current status: steps 1–3 implemented, opt-in only. Capture proof is kept in an
in-process WeakMap, so upstream metadata cannot forge retention. Unit and actual
Smart dispatcher tests cover preservation, budgets and forwarding boundaries.
Step 4 now has configured policies and retained-index vector fusion, with local
fallback and exact-text verification. Step 5 has a local synthetic smoke benchmark
for logs/JSON/diff near 1 MB, all retaining the target diagnostic within the token
budget. Real PostgreSQL/provider integration and deployment-scale acceptance
remain pending; no production latency guarantee is implied.
