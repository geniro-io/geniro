# Memory

## Memory Backend
<!-- Route agent learnings (L2) through a custom backend. Default = built-in .geniro/knowledge/learnings.jsonl. The `read` tool MUST be read-only. Contract: ${CLAUDE_PLUGIN_ROOT}/skills/_shared/memory-backend.md -->
<!-- Backend = geniro-graphiti-mcp (clean-room Graphiti MCP, synchronous awaited writes — no silent-drop queue). Server registered under the name `graphiti`, so the tool prefix stays `mcp__graphiti__`. PREFER BULK: when storing MORE THAN ONE learning in a single operation, use `mcp__graphiti__add_memory_bulk` (one batched extraction/embedding pass) instead of repeated `add_memory` calls; use `add_memory` only for a single learning. -->
- layer: learnings
  mode: replace             # replace = Graphiti is the SOLE store (no local file write); mirror = file + backend
  write: mcp tool `mcp__graphiti__add_memory`        # single learning; for a batch of >1 prefer mcp__graphiti__add_memory_bulk
  read:  mcp tool `mcp__graphiti__search_memory_facts`
