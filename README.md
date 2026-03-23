# opencode-memory-plugin

Persistent cross-session memory plugin for OpenCode, designed as a port of claude-mem to OpenCode according to the DAQ in this repository.

## Current Scope

- Local persistence in SQLite with FTS5 index
- Hybrid-ready architecture for `FTS5 + sqlite-vec`
- Crash-safe pending queue for tool outputs
- Async AI compression pipeline (in-process)
- Session summaries with structured fields (requested/investigated/learned/completed/next steps)
- Global persona memory (cross-project user preferences)
- Git worktree detection with multi-project memory queries
- Prior session continuity ("Where You Left Off" context block)
- Token economics display (compression savings in context header)
- Retrieval tools: `memory_search`, `memory_timeline`, `memory_get`
- Write tool: `memory_add` (explicit agent-controlled persistence)
- Delete tool: `memory_forget` (with preview + confirmation token)
- Persona tools: `memory_persona_get`, `memory_persona_update`, `memory_persona_patch`, `memory_persona_clear`
- System context injection via `experimental.chat.system.transform`

## Install

```bash
bun add opencode-memory-plugin
```

Add in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-memory-plugin"]
}
```

## Optional Memory Config

You can provide plugin-specific config files in any of these paths:

- `~/.config/opencode/memory/config.json`
- `~/.config/opencode/memory/config.jsonc`
- `.opencode/memory.json`
- `.opencode/memory.jsonc`
- `opencode-memory.json`
- `opencode-memory.jsonc`

Or set `OPENCODE_MEMORY_CONFIG=/absolute/path/to/config.json`.

Example:

```json
{
  "dbPath": "~/.config/opencode/memory/memory.db",
  "indexSize": 50,
  "sampleSize": 5,
  "maxPendingRetries": 3,
  "compressionModel": null,
  "maxRawContentSize": 50000,
  "privacyStrip": true,
  "enableSemanticSearch": true,
  "embeddingModel": "Xenova/all-MiniLM-L6-v2",
  "embeddingDimensions": 384,
  "semanticSearchMaxResults": 8,
  "semanticContextMaxResults": 3,
  "semanticMinScore": 0.55,
  "hybridSearchAlpha": 0.65,
  "compressionBatchSize": 10,
  "retentionDays": 90,
  "logLevel": "info"
}
```

Semantic search is enabled by default. The plugin keeps FTS5 as the lexical base and uses local-only embeddings (`@huggingface/transformers`) plus `sqlite-vec` as the preferred semantic layer. If native vector loading is unavailable in the current Bun runtime, the plugin falls back to semantic reranking in JavaScript over persisted embeddings while preserving the same public behavior.

## Persona Memory

The plugin maintains a global user persona that persists across all projects. It learns automatically from conversations and is injected into every session's context.

| Tool | Description |
|------|-------------|
| `memory_persona_get` | View the current persona |
| `memory_persona_update` | Replace the persona content |
| `memory_persona_patch` | Append new facts to the persona |
| `memory_persona_clear` | Clear the persona memory |

The persona is automatically learned from user messages (every 3 turns) and injected as `<persona_context>` before project memory in the system prompt.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

## Notes

- This package targets OpenCode plugin APIs currently exposed by `@opencode-ai/plugin@1.2.x`.
- The architecture DAQ in `docs/DAQ-opencode-memory-plugin.md` is the source of truth for the hybrid rollout.
