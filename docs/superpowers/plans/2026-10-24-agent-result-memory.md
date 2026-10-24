# Agent access to stored tool results

Source: Basic Memory full project context, section 6. This work closes a missing part of the original specification; HTTP history alone does not provide agent recall.

## Additive MCP interface

Expose these meta-tools on Smart Routing routes when history storage is available:

- `get_tool_result(result_id)`: original stored MCP envelope, bounded default response; oversized records return size information and instructions for range retrieval.
- `get_tool_result_range(result_id, start, end)`: explicit end-exclusive UTF-8 byte range. Return base64 bytes for exact reconstruction, with offsets, total size and RAW digest. Never silently repair a range cutting a UTF-8 sequence.
- `search_tool_result(result_id, query, limit)`: bounded chunk retrieval using existing vector/lexical fallback.
- `search_tool_results(query, filters, limit)`: owner-scoped history retrieval; omit full RAW from search responses.
- `pin_tool_result(result_id)` and `unpin_tool_result(result_id)`: mutate only the separate pin state.

Existing search/describe/call behavior and disabled-database behavior remain compatible. Reuse existing repositories and indexing; do not create another database or mutable RAW copy.

## Execution and ownership

Derive access from authenticated request context and the caller's resolved route, never from a user-supplied owner field. Reuse existing owner/key conventions. Deny unidentifiable callers; distinguish authenticated user, bearer key and session fallback explicitly. Enforce scope on both exact reads and searches, including group/server visibility. Do not allow a result ID alone to grant cross-owner access. Anonymous shared scopes need explicit handling before exposure.

Dispatch locally before upstream execution and register the names with the existing Smart Routing meta-tool routing set. Retrieval and pin operations must not execute an upstream tool or create another tool-result history record. Increase usage only after an authorized successful retrieval.

Keep metadata-only payload omissions, retained-result-not-found behavior and storage-unavailable responses explicit. Never claim a missing RAW payload is recoverable by repeating the original operation.

## Verification

Test RAW identity/digest, exact bytes including split UTF-8 sequences, bounded responses, search fallback, pin/unpin, denied foreign results, group filtering, unavailable storage, unchanged existing meta-tools and no capture/execute recursion. Real PostgreSQL tests remain gated on the pending current credential; do not reuse the rejected credential.
