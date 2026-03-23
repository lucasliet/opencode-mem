# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the plugin source. Key areas are `src/hooks/` for OpenCode lifecycle hooks, `src/storage/` for SQLite and Drizzle-backed persistence, `src/compression/` for observation parsing, quality validation, and compression, `src/context/` for system prompt injection, and `src/tools/` for exposed memory tools. `test/` holds Bun tests. `dist/` is generated build output and should only change as part of a build or release step.

Source layout:
- `src/index.ts` — plugin entry point, exports `createMemoryPlugin()` and `MemoryPlugin`
- `src/types.ts` — all shared interfaces and const enums
- `src/config.ts` — config loading from filesystem and env vars (no SDK API calls)
- `src/utils.ts` — pure utility functions (no side effects)
- `src/logger.ts` — `MemoryLogger` wrapping `client.app.log`
- `src/storage/schema.ts` — Drizzle table definitions for textual memory, vector metadata, and persona memory
- `src/storage/db.ts` — SQLite init, WAL mode, FTS5 virtual table/triggers, and `sqlite-vec` availability handling
- `src/storage/store.ts` — `MemoryStore` class with CRUD, hybrid search, deletion, and stats methods
- `src/storage/persona.ts` — `PersonaStore` class with global user persona CRUD
- `src/compression/privacy.ts` — `stripSensitiveTokens()`
- `src/compression/prompts.ts` — compression and session summary prompt builders
- `src/compression/parser.ts` — `parseObservation()` and `parseSessionSummary()` with fallback
- `src/compression/quality.ts` — `validateObservation()` quality gate (high/medium/low)
- `src/compression/pipeline.ts` — `CompressionPipeline` with queue, retry, orphan recovery, and post-persist embedding stage
- `src/compression/compressor.ts` — `LanguageModelObservationCompressor` and `SessionPromptObservationCompressor`
- `src/compression/persona-extractor.ts` — `PersonaExtractor` for extracting persona facts from conversations
- `src/compression/persona-prompts.ts` — prompts for persona extraction and summarization
- `src/embeddings/` — local embedding provider, text builder, and embedding contracts
- `src/hooks/tool-after.ts` — captures tool outputs via `tool.execute.after`
- `src/hooks/system-transform.ts` — injects memory and persona context via `experimental.chat.system.transform`
- `src/hooks/events.ts` — session lifecycle via `event`, debounced summaries, shutdown
- `src/hooks/chat-message.ts` — captures user prompts and learns persona facts via `chat.message`
- `src/hooks/compaction.ts` — memory anchors via `experimental.session.compacting`
- `src/context/generator.ts` — `generateSessionContext()` and `generateCompactionContext()` with conservative semantic enrichment, token economics header, and persona injection
- `src/context/prior-session.ts` — `getPriorSessionContext()` for "Where You Left Off" continuity between sessions
- `src/worktree.ts` — `detectWorktree()` for git worktree detection and parent repo resolution
- `src/tools/memory-search.ts` — hybrid memory search with low-quality `[?]` marker
- `src/tools/memory-timeline.ts` — chronological browsing with cursor pagination
- `src/tools/memory-get.ts` — full observation fetch by IDs with `rawFallback` display
- `src/tools/memory-add.ts` — explicit agent-controlled persistence with quality `high`
- `src/tools/memory-forget.ts` — deletion with preview (`confirm=false`) / execute (`confirm=true`)
- `src/tools/memory-stats.ts` — observability: counts, quality distribution, tool usage, DB size
- `src/tools/memory-persona-get.ts` — view the global user persona memory
- `src/tools/memory-persona-update.ts` — replace the global user persona memory
- `src/tools/memory-persona-patch.ts` — append facts to the existing persona
- `src/tools/memory-persona-clear.ts` — clear the global user persona memory

## Build, Test, and Development Commands
Run `bun install` to install dependencies. Use `bun run typecheck` to validate both app and test TypeScript configs without emitting files. Use `bun test` to run the Bun test suite in `test/`. Use `bun run build` to compile the package into `dist/` with `tsc -p tsconfig.json`. For a clean contributor loop, prefer: `bun run typecheck && bun test && bun run build`.

Current test coverage should continue to prioritize `config`, `parser`, `privacy`, `quality`, `store`, `pipeline`, and any new hybrid/context behavior.

## Coding Style & Naming Conventions
This package uses ESM TypeScript with 2-space indentation, semicolon-free style, and named exports. Follow the existing patterns: factory functions use `createX` names, classes use PascalCase, and tests use `should...` style names such as `shouldParseValidJsonObservation`. Keep files focused by domain and place new code in the matching module folder instead of growing `index.ts`. Add TSDoc to authored functions and keep code self-explanatory without inline comments unless absolutely necessary.

## Testing Guidelines
Tests run on Bun via `bun:test`. Add new coverage under `test/` with filenames ending in `.test.ts`. Mirror the production concern being tested. Keep tests deterministic, prefer small fixtures inline, and cover failure paths for parsing, privacy stripping, queue recovery, quality gate scoring, deletion, and project scoping. Use `:memory:` databases in store and pipeline tests.

## Commit & Pull Request Guidelines
Use short, imperative commit messages with Conventional Commit prefixes (`feat:`, `fix:`, `test:`, `refactor:`). Pull requests should describe the plugin behavior changed, list validation commands run, and call out config, schema, or storage-impacting changes. Include sample config or tool output when the change affects integration behavior.

## Security & Configuration Tips
Do not hardcode secrets or machine-specific paths. Keep memory data project-scoped, and prefer config via `OPENCODE_MEMORY_CONFIG` or supported JSON/JSONC config files documented in `README.md`. Never access `~` paths directly — always use `resolveHomePath()`.

## Critical: OpenCode Plugin Init Constraints

**NEVER call any SDK API during plugin initialization.** This includes:
- `client.config.get()` — deadlocks because the OpenCode HTTP server is blocked waiting for the plugin to return its hooks
- `client.app.log()` at init time — use `void logger.info(...)` (fire-and-forget) for the init log message
- Any other `client.*` call inside the `async (input: PluginInput) => { ... }` body before `return`

Plugin init must use only local I/O: filesystem reads (`findConfigPaths`, `loadConfigFiles`), env vars, and SQLite (via `bun:sqlite`). SDK API calls are safe inside hooks and pipeline methods because those run after the plugin returns its hooks object.

`loadOpenCodeConfig()` is available for lazy runtime config resolution inside `CompressionPipeline.loadRuntimeConfig()` — this is called during compression, which happens after init completes.

## OpenCode Plugin Hook Names (SDK v1.2.x)

The DAQ uses different names than the real SDK. Correct hook names:
- `tool.execute.after` — captures tool outputs (DAQ: `afterResponse` / `PostToolUse`)
- `experimental.chat.system.transform` — injects system prompt context (DAQ: `beforePrompt` / `SessionStart`)
- `event` — session lifecycle events: `session.created`, `session.idle`, `session.compacted`, `session.deleted`
- `chat.message` — captures user prompts
- `experimental.session.compacting` — memory anchors during context window compaction

## Local Installation Workflow

The plugin is installed in the global OpenCode config at `~/.config/opencode/`:

```bash
# One-time setup (already done)
cd ~/.config/opencode && bun add /Users/lucas/opencode-mem
```

In `~/.config/opencode/opencode.json`:
```json
"plugin": ["opencode-memory-plugin"]
```

**After every source change**, rebuild and restart OpenCode:
```bash
cd /Users/lucas/opencode-mem && bun run build
# then reopen OpenCode — it reads dist/index.js from the original path directly
```

No need to re-run `bun add` after rebuild. OpenCode resolves to `file:///Users/lucas/opencode-mem/dist/index.js`.

## Schema Overview

Six SQLite tables (all project-scoped via `project_id`):
- `observations` — compressed tool outputs with `quality` (high/medium/low) and `raw_fallback`
- `pending_messages` — crash-safe queue (status: pending → processing → processed/failed)
- `session_summaries` — AI-generated per-session summaries
- `user_prompts` — raw user prompt text for summarization
- `deletion_log` — LGPD compliance audit trail for all deletions
- `tool_usage_stats` — per-session tool call counters for observability

One global table (no project scoping):
- `persona_memory` — learned user persona (communication style, code preferences, work patterns)

FTS5 virtual table `observations_fts` indexes: `title`, `subtitle`, `narrative`, `facts`, `concepts`, `files_involved`. Sync maintained via `AFTER INSERT/DELETE/UPDATE` triggers.

Hybrid memory architecture keeps FTS5 mandatory for lexical retrieval, deletion governance, and fallback. `sqlite-vec` is the preferred local vector backend for semantic retrieval, but the plugin must degrade cleanly when native extension loading is unavailable in Bun. In that case, keep embeddings persisted locally and use a JavaScript semantic fallback instead of breaking retrieval.

## Worktree Support

When the plugin detects a git worktree (`.git` is a file pointing to a parent repo), it queries observations and summaries from both the parent repo and the worktree project. This enables continuity when the user branches into a worktree — prior observations from `main` remain visible. Detection uses `detectWorktree()` from `src/worktree.ts`, and multi-project queries use `getRecentObservationsMulti()` / `getRecentSummariesMulti()` from `MemoryStore`.

## Context Injection Structure

`generateSessionContext()` builds a system prompt block with:
1. `<persona_context>` — learned user persona
2. `## Where You Left Off` — summary of the most recent prior session (completed + learned + next steps)
3. `<memory_context>` — memory status header with token economics, observation index, detailed samples, semantic observations, session summaries, and available tools footer

New databases get all columns inline via `CREATE TABLE`. Existing databases from before the `quality`/`raw_fallback` additions are migrated by `ensureSchema()` via `ALTER TABLE ... ADD COLUMN` with try/catch. Any vector-layer rollout must preserve this pattern: safe startup, idempotent migration, and no plugin-init dependence on remote services or SDK calls.
