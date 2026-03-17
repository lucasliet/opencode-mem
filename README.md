# @opencode-ai/plugin-memory

Persistent cross-session memory plugin for OpenCode, designed as a port of claude-mem to OpenCode according to the DAQ in this repository.

## MVP Scope

- Local persistence in SQLite with FTS5 index
- Crash-safe pending queue for tool outputs
- Async AI compression pipeline (in-process)
- Session summaries
- Retrieval tools: `memory_search`, `memory_timeline`, `memory_get`
- System context injection via `experimental.chat.system.transform`

## Install

```bash
bun add @opencode-ai/plugin-memory
```

Add in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@opencode-ai/plugin-memory"]
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
  "compressionBatchSize": 10,
  "retentionDays": 90,
  "logLevel": "info"
}
```

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

## Notes

- This package targets OpenCode plugin APIs currently exposed by `@opencode-ai/plugin@1.2.x`.
- DAQ legacy naming (`beforePrompt`, `afterResponse`) is mapped in this implementation to:
  - `tool.execute.after` for capture
  - `experimental.chat.system.transform` for injection
