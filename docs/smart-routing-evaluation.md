# Paired Smart Routing evaluation

Run the offline reporter with an observations file, or send JSON on stdin:

```sh
node scripts/evaluate-smart-routing.js tests/fixtures/smart-routing-evaluation.synthetic.json
```

The bundled example is deliberately synthetic. It checks the reporting workflow,
not embeddings, actual discovery, model quality, latency or production readiness.
The command makes no provider or gateway calls and does not change settings.

Use version 1 and `k` from 1 to 100. Each case needs a unique `id`, `phase`
(`cold` or `warm`), `evidence` (`synthetic`, `recorded` or `live`), a `relevant`
list, and paired `baseline` and `mcpZero` observations. Each observation has an
ordered `tools` list. A tool identity is an object with exact `serverName` and
`toolName`; duplicate identities are rejected instead of inflating the scores.

Optional observation fields are measured `latencyMs`, integer `outputTokens` and
integer `embeddingRequests`, all nonnegative. Measure the same response boundary
and tokenizer for both methods. Omit unavailable fields; the reporter returns null
and zero samples rather than inventing zero cost. It reports mean and nearest-rank
p50/p95 for available samples. Token counts do not imply currency prices.

Ranking metrics are macro averages across paired case rows, separately per phase:
precision divides relevant hits by K (short responses do not shrink the
denominator), recall divides by all labelled relevant tools, MRR uses the first
relevant rank within K, and nDCG uses binary relevance and log2 discount. Empty
ground-truth lists are unanswerable queries: recall/MRR/nDCG exclude them, while a
separate abstention accuracy requires an empty response. Precision includes all
cases. Return identical repetitions per query to avoid weighting some tasks more.

For a real acceptance run, label representative task/tool pairs before inspecting
the outputs. Use a separate test hub with the same catalogue, scope, filters,
threshold and embedding model for each method; change only MCP-Zero. Capture the
actual ordered `search_tools` outputs with a collector that preserves the existing
client's scope and authorization. Run cold and warm samples with a documented
cache-reset procedure; record cache state, model, catalogue revision and tokenizer
alongside the privately held observations. Include ambiguous, unsupported and
cross-server tasks, not just successful lookups. Do not change a production
gateway's routing settings to collect the comparison.

Only tool identities, labels and measurements are needed by this reporter. Keep
private catalogue identities and captured client data outside the public repo;
never include access tokens, authorization headers, credentials or full tool RAW.
Evidence labels and measurements are caller claims, not independently verified
by the reporter. A green report alone does not prove end-to-end discovery quality.
