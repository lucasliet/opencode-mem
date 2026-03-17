# DAQ — Documento de Arquitetura e Qualidade
## Plugin de Memória Persistente Cross-Session para OpenCode
### Portabilidade do claude-mem → `@opencode-ai/plugin-memory`

**Versão:** 1.0.0
**Data:** 2026-03-17
**Status:** Proposta Arquitetural
**Autor:** Lucas

---

## 1. User Story

**Como** desenvolvedor que utiliza o OpenCode como agente de codificação no terminal,
**Eu quero** que o contexto das minhas sessões anteriores (decisões arquiteturais, bugs resolvidos, padrões adotados, ferramentas configuradas) seja automaticamente capturado, comprimido e recuperável,
**Para que** eu não precise repetir contexto a cada nova sessão e o agente possa oferecer respostas mais relevantes com base no histórico acumulado do meu projeto.

**Critérios de Aceite:**
- Observações de tool executions são capturadas e comprimidas automaticamente (~500 tokens a partir de 10KB–500KB de output bruto)
- Ao iniciar uma nova sessão, o agente recebe automaticamente um índice compacto das últimas observações (~1.500 tokens)
- O agente pode buscar memórias por keyword (FTS5) e, opcionalmente, por similaridade semântica
- Dados persistem em SQLite no filesystem local, sem dependências externas pesadas (sem ChromaDB)
- O plugin funciona com qualquer provider configurado no OpenCode (Anthropic, OpenAI, Gemini, local)
- Crash-safety: nenhuma observação é perdida em caso de crash — fila `pending_messages` garante reprocessamento
- Sessões são sumarizadas automaticamente ao finalizar

---

## 2. Cenário Atual (AS-IS)

### 2.1 Limitação do OpenCode

O OpenCode (v0.2.x, ~123k stars, Anomaly/SST) possui memória **exclusivamente session-scoped**. O sistema de auto-compaction existente apenas sumariza mensagens dentro de uma única sessão quando o contexto se aproxima do limite da janela. Ao encerrar uma sessão, todo o contexto é perdido.

Não existe mecanismo nativo para:
- Persistir observações entre sessões
- Recuperar decisões ou contexto de sessões anteriores
- Buscar no histórico de interações passadas
- Injetar contexto cross-session automaticamente

### 2.2 claude-mem como referência

O claude-mem (~31.8k stars) resolve exatamente este problema para o Claude Code via:
- **Worker Service Express.js** rodando como sidecar na porta 37777
- **5 lifecycle hooks** (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) que fazem chamadas HTTP fire-and-forget ao worker
- **Compressão AI 10:1 a 100:1** de tool outputs em "observations" estruturadas
- **Dual storage**: SQLite FTS5 (keyword) + ChromaDB (semântico)
- **Progressive disclosure 3-layer**: index search → timeline → full fetch
- **Context injection** de ~1.500 tokens no início de cada sessão

### 2.3 Problemas conhecidos do claude-mem

- ChromaDB consome **35GB+ de RAM** no macOS, com segfaults reportados no Linux
- Arquitetura sidecar adiciona complexidade operacional (daemon lifecycle, port management)
- Acoplamento forte ao Claude Agent SDK (XML prompt/response parsing)
- Migração manual de schemas SQLite (10+ migrations)
- Sem suporte a múltiplos providers

---

## 3. Heurísticas

### 3.1 Decisões Arquiteturais

| # | Decisão | Justificativa |
|---|---------|---------------|
| H1 | **In-process** em vez de sidecar | Elimina complexidade de daemon, HTTP round-trips e port management. OpenCode já roda como servidor Bun persistente |
| H2 | **SQLite FTS5 only** (sem ChromaDB) | Evita 35GB+ RAM, segfaults, dependência externa. FTS5 cobre 90% dos casos de busca. Semântico via `sqlite-vec` como fase futura |
| H3 | **Vercel AI SDK** em vez de Claude Agent SDK | Reutiliza o provider já configurado no OpenCode. Compressão funciona com qualquer modelo |
| H4 | **Drizzle ORM** em vez de bun:sqlite direto | Consistência com o codebase do OpenCode. Migrations automáticas. Type-safety |
| H5 | **Plugin npm** (`@opencode-ai/plugin-memory`) | Distribuição trivial. Instalação com uma linha no `opencode.json` |
| H6 | **Compressão assíncrona in-process** | Background processing via Bun async. `pending_messages` garante crash-safety sem daemon separado |
| H7 | **Progressive disclosure 3-layer** (mantido) | Padrão comprovado do claude-mem: index (~50-100 tokens/resultado) → timeline → full fetch. Minimiza custo de tokens |
| H8 | **JSON structured output** em vez de XML parsing | Multi-provider compatível. Sem parser XML customizado |

### 3.2 Restrições

- **Runtime:** Bun (compatível com OpenCode)
- **Storage:** SQLite via Drizzle ORM, localizado em `~/.config/opencode/memory/`
- **Sem dependências nativas pesadas:** ChromaDB, FAISS ou similares estão fora do escopo inicial
- **Modelo de compressão:** utiliza o provider/modelo configurado no OpenCode (ou modelo dedicado menor se configurado)
- **Limite de tokens do context injection:** máximo ~2.000 tokens no session start

---

## 4. Planejamento (TO-BE)

### 4.1 Visão Geral da Solução

```
┌─────────────────────────────────────────────────────────┐
│                    OpenCode Server (Bun)                 │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │            @opencode-ai/plugin-memory              │  │
│  │                                                    │  │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────────┐   │  │
│  │  │  Hooks   │  │  Tools   │  │   Compression  │   │  │
│  │  │          │  │          │  │    Pipeline     │   │  │
│  │  │ before   │  │ mem_     │  │                 │   │  │
│  │  │ Prompt   │  │ search   │  │ PendingQueue    │   │  │
│  │  │          │  │          │  │     ↓           │   │  │
│  │  │ after    │  │ mem_     │  │ AI Compress     │   │  │
│  │  │ Response │  │ timeline │  │ (Vercel SDK)    │   │  │
│  │  │          │  │          │  │     ↓           │   │  │
│  │  │ on       │  │ mem_     │  │ Store           │   │  │
│  │  │ Session  │  │ get      │  │ Observation     │   │  │
│  │  │ Events   │  │          │  │                 │   │  │
│  │  └────┬─────┘  └────┬─────┘  └───────┬────────┘   │  │
│  │       │              │                │             │  │
│  │       └──────────────┴────────────────┘             │  │
│  │                       │                             │  │
│  │              ┌────────▼────────┐                    │  │
│  │              │   MemoryStore   │                    │  │
│  │              │  (Drizzle ORM)  │                    │  │
│  │              └────────┬────────┘                    │  │
│  │                       │                             │  │
│  │              ┌────────▼────────┐                    │  │
│  │              │  SQLite + FTS5  │                    │  │
│  │              │  ~/.config/     │                    │  │
│  │              │  opencode/      │                    │  │
│  │              │  memory/        │                    │  │
│  │              └─────────────────┘                    │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Mapeamento de Hooks (claude-mem → OpenCode)

| claude-mem Hook | OpenCode Hook/Event | Função |
|---|---|---|
| `SessionStart` | `beforePrompt` (1ª mensagem) | Injeta índice de memórias recentes no system prompt (~1.500 tokens) |
| `UserPromptSubmit` | `Bus.subscribe('session.created')` | Cria registro de sessão de memória |
| `PostToolUse` | `afterResponse` (filtrando tool results) | Enfileira tool outputs no `pending_messages` → dispara compressão async |
| `Stop` | `Bus.subscribe('session.updated')` status change | Gera session summary via AI |
| `SessionEnd` | Process exit handler / session completion | Flush da fila pendente, cleanup |

### 4.3 Fluxo de Dados

```
[Usuário envia prompt]
        │
        ▼
[beforePrompt Hook]──────────► Consulta MemoryStore
        │                       Gera índice compacto
        │                       Injeta no system prompt
        ▼
[LLM processa com contexto de memória]
        │
        ▼
[LLM executa tools]
        │
        ▼
[afterResponse Hook]──────────► Extrai tool results da response
        │                        Persiste em pending_messages (crash-safe)
        │                        Dispara compressão async
        ▼
[Compression Pipeline]────────► Vercel AI SDK generateText()
        │                        Prompt estruturado → JSON output
        │                        Gera Observation (~500 tokens)
        ▼
[MemoryStore.save()]──────────► INSERT observations (Drizzle)
        │                        UPDATE FTS5 index
        │                        UPDATE pending_messages status
        ▼
[Sessão encerra]
        │
        ▼
[Session Summary]─────────────► AI gera resumo da sessão
                                 Persiste em session_summaries
```

---

## 5. Arquitetura da Feature

### 5.1 Estrutura de Diretórios

```
packages/plugin-memory/
├── src/
│   ├── index.ts                    # Plugin entry point (exports PluginDefinition)
│   ├── hooks/
│   │   ├── before-prompt.ts        # Context injection no session start
│   │   ├── after-response.ts       # Captura tool results → pending queue
│   │   └── session-lifecycle.ts    # Session create/end handlers
│   ├── tools/
│   │   ├── memory-search.ts        # FTS5 keyword search (retorna índice compacto)
│   │   ├── memory-timeline.ts      # Busca cronológica com filtros
│   │   └── memory-get.ts           # Batch fetch de observations completas por ID
│   ├── compression/
│   │   ├── pipeline.ts             # Orquestração: queue → compress → store
│   │   ├── prompts.ts              # Prompts de compressão (model-agnostic)
│   │   └── parser.ts               # JSON structured output parser
│   ├── storage/
│   │   ├── schema.ts               # Drizzle table definitions
│   │   ├── store.ts                # CRUD operations (MemoryStore)
│   │   ├── search.ts               # FTS5 query builder (MemorySearch)
│   │   └── migrations/             # Drizzle migration files
│   ├── context/
│   │   └── generator.ts            # Gera context injection payload
│   └── config.ts                   # Plugin configuration schema
├── package.json
├── tsconfig.json
└── README.md
```

### 5.2 Schema do Banco de Dados (Drizzle)

```typescript
// storage/schema.ts
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"

export const observations = sqliteTable("observations", {
  id: text("id").primaryKey(),                    // UUID v7 (sortable)
  sessionId: text("session_id").notNull(),
  type: text("type").notNull(),                   // "tool_output" | "file_change" | "error" | "decision"
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  narrative: text("narrative").notNull(),          // Compressed description
  facts: text("facts"),                            // JSON array of extracted facts
  concepts: text("concepts"),                      // JSON array of key concepts
  filesInvolved: text("files_involved"),           // JSON array of file paths
  rawTokenCount: integer("raw_token_count"),       // Original token count (before compression)
  compressedTokenCount: integer("compressed_token_count"),
  toolName: text("tool_name"),
  modelUsed: text("model_used"),                   // Which model compressed this
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
})

export const sessionSummaries = sqliteTable("session_summaries", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().unique(),
  requested: text("requested"),                    // What was asked
  investigated: text("investigated"),              // What was explored
  learned: text("learned"),                        // Key learnings
  completed: text("completed"),                    // What got done
  nextSteps: text("next_steps"),                   // Planned next actions
  observationCount: integer("observation_count"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
})

export const pendingMessages = sqliteTable("pending_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  toolName: text("tool_name").notNull(),
  rawContent: text("raw_content").notNull(),       // Raw tool output
  status: text("status").notNull().default("pending"), // pending | processing | processed | failed
  retryCount: integer("retry_count").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  processedAt: integer("processed_at", { mode: "timestamp" }),
})

export const userPrompts = sqliteTable("user_prompts", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
})

// FTS5 virtual table — criada via migration SQL raw
// CREATE VIRTUAL TABLE observations_fts USING fts5(
//   title, subtitle, narrative, facts, concepts,
//   content=observations,
//   content_rowid=rowid
// );
```

### 5.3 Plugin Entry Point

```typescript
// index.ts
import type { PluginDefinition } from "@opencode-ai/plugin"
import { beforePromptHook } from "./hooks/before-prompt"
import { afterResponseHook } from "./hooks/after-response"
import { sessionLifecycleHook } from "./hooks/session-lifecycle"
import { memorySearchTool } from "./tools/memory-search"
import { memoryTimelineTool } from "./tools/memory-timeline"
import { memoryGetTool } from "./tools/memory-get"
import { initializeStore } from "./storage/store"
import { loadConfig } from "./config"

export default {
  name: "memory",
  version: "1.0.0",

  async setup({ hooks, tools, bus, config }) {
    const pluginConfig = loadConfig(config)
    const store = await initializeStore(pluginConfig.dbPath)

    hooks.add("beforePrompt", beforePromptHook(store, pluginConfig))
    hooks.add("afterResponse", afterResponseHook(store, pluginConfig))

    tools.register(memorySearchTool(store))
    tools.register(memoryTimelineTool(store))
    tools.register(memoryGetTool(store))

    bus.subscribe("session.created", sessionLifecycleHook.onStart(store))
    bus.subscribe("session.updated", sessionLifecycleHook.onEnd(store, pluginConfig))
  },
} satisfies PluginDefinition
```

### 5.4 Compression Pipeline

```typescript
// compression/pipeline.ts
import { generateText } from "ai"
import { buildCompressionPrompt } from "./prompts"
import { parseObservation } from "./parser"
import type { MemoryStore } from "../storage/store"

export const createCompressionPipeline = (store: MemoryStore, model: LanguageModel) => {

  const processQueue = async () => {
    const pending = await store.getPendingMessages("pending", 10)
    if (!pending.length) return

    const tasks = pending.map(async (msg) => {
      await store.updatePendingStatus(msg.id, "processing")

      try {
        const { text } = await generateText({
          model,
          messages: [{ role: "user", content: buildCompressionPrompt(msg.rawContent, msg.toolName) }],
          maxTokens: 1000,
        })

        const observation = parseObservation(text, msg)
        await store.saveObservation(observation)
        await store.updatePendingStatus(msg.id, "processed")
      } catch (error) {
        const retries = msg.retryCount + 1
        const status = retries >= 3 ? "failed" : "pending"
        await store.updatePendingStatus(msg.id, status, retries, String(error))
      }
    })

    await Promise.allSettled(tasks)
  }

  return { processQueue }
}
```

### 5.5 Prompt de Compressão (Model-Agnostic)

```typescript
// compression/prompts.ts
export const buildCompressionPrompt = (rawContent: string, toolName: string) => `
You are an observation compressor for a coding assistant's memory system.
Compress the following tool output into a structured observation.

Tool: ${toolName}
Raw output (may be very long):
---
${rawContent.slice(0, 50_000)}
---

Respond with ONLY valid JSON, no markdown fences:
{
  "title": "Short descriptive title (max 10 words)",
  "subtitle": "One-line context (max 20 words)",
  "narrative": "2-3 sentence summary of what happened, what was found, or what changed",
  "facts": ["Specific fact 1", "Specific fact 2"],
  "concepts": ["concept1", "concept2"],
  "filesInvolved": ["path/to/file1.ts", "path/to/file2.ts"],
  "type": "tool_output | file_change | error | decision"
}

Rules:
- Be extremely concise. Target ~500 tokens total.
- Extract only actionable facts and decisions, not boilerplate.
- File paths must be exact as they appear in the output.
- Concepts should be searchable keywords (technologies, patterns, libraries).
- If the output is an error, focus on root cause and resolution.
`

export const buildSessionSummaryPrompt = (observations: Observation[]) => `
Summarize this coding session based on the following observations.
Respond with ONLY valid JSON:
{
  "requested": "What the user asked for (1-2 sentences)",
  "investigated": "What was explored or researched (1-2 sentences)",
  "learned": "Key learnings or discoveries (1-2 sentences)",
  "completed": "What was accomplished (1-2 sentences)",
  "nextSteps": "Planned or suggested next actions (1-2 sentences)"
}

Observations:
${observations.map((o, i) => `[${i + 1}] ${o.title}: ${o.narrative}`).join("\n")}
`
```

### 5.6 Context Injection (beforePrompt)

```typescript
// hooks/before-prompt.ts
import type { MemoryStore } from "../storage/store"
import type { PluginConfig } from "../config"

export const beforePromptHook = (store: MemoryStore, config: PluginConfig) =>
  async ({ prompt, sessionId }: BeforePromptContext) => {
    const recentObservations = await store.getRecentObservations(config.indexSize)
    if (!recentObservations.length) return { prompt }

    const index = recentObservations
      .map((o) => `[${o.id}] ${o.title} — ${o.subtitle} (${o.type}, ${formatRelativeTime(o.createdAt)})`)
      .join("\n")

    const samples = recentObservations
      .slice(0, config.sampleSize)
      .map((o) => `### ${o.title}\n${o.narrative}\nFacts: ${o.facts}\nFiles: ${o.filesInvolved}`)
      .join("\n\n")

    const memoryContext = `
<memory_context>
You have access to persistent memory from previous sessions.

## Recent Observation Index (${recentObservations.length} entries)
${index}

## Latest Observations (full detail)
${samples}

## Memory Tools Available
- memory_search: Search observations by keyword. Returns compact results.
- memory_timeline: Browse observations chronologically with date filters.
- memory_get: Fetch full observation details by ID (batch supported).

Use these tools when the user references past work or when prior context would help.
</memory_context>
`
    return { prompt: memoryContext + "\n\n" + prompt }
  }
```

### 5.7 Tool Registration (memory_search)

```typescript
// tools/memory-search.ts
import type { MemoryStore } from "../storage/store"

export const memorySearchTool = (store: MemoryStore) => ({
  name: "memory_search",
  description: "Search persistent memory for observations from previous sessions. Returns compact index entries. Use memory_get to fetch full details.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search keywords" },
      limit: { type: "number", description: "Max results (default 10, max 50)" },
      type: { type: "string", enum: ["tool_output", "file_change", "error", "decision"], description: "Filter by observation type" },
    },
    required: ["query"],
  },

  async execute({ query, limit = 10, type }: SearchParams) {
    const results = await store.searchFTS(query, Math.min(limit, 50), type)

    return results
      .map((r) => `[${r.id}] ${r.title} — ${r.subtitle} (${r.type}, ${formatRelativeTime(r.createdAt)})`)
      .join("\n")
  },
})
```

### 5.8 Configuração do Plugin

```jsonc
// opencode.json (exemplo de config do usuário)
{
  "plugins": {
    "memory": {
      "enabled": true,
      "dbPath": "~/.config/opencode/memory/memory.db",   // Default
      "indexSize": 50,            // Observations no índice do session start
      "sampleSize": 5,           // Observations com detalhes completos no injection
      "maxPendingRetries": 3,    // Retentativas para compressão falhada
      "compressionModel": null,  // null = usa o modelo principal do OpenCode
      "maxRawContentSize": 50000,// Trunca tool outputs maiores que isso (chars)
      "enableSemanticSearch": false,  // Fase futura (sqlite-vec)
      "privacyStrip": true       // Remove tokens sensíveis antes de comprimir
    }
  }
}
```

---

## 6. Refinamento Técnico (Code-Aware)

### 6.1 Integração com Drizzle ORM

O OpenCode utiliza Drizzle ORM com o driver `better-sqlite3` (via Bun). A migration da FTS5 virtual table requer SQL raw porque Drizzle não suporta `CREATE VIRTUAL TABLE` nativamente:

```typescript
// storage/migrations/0001_create_memory_tables.ts
import { sql } from "drizzle-orm"

export const up = async (db: DrizzleDB) => {
  // Drizzle managed tables são criadas automaticamente via schema push
  // FTS5 precisa de SQL raw:
  await db.run(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      title, subtitle, narrative, facts, concepts,
      content=observations,
      content_rowid=rowid
    )
  `)

  // Triggers para manter FTS sincronizado
  await db.run(sql`
    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts)
      VALUES (new.rowid, new.title, new.subtitle, new.narrative, new.facts, new.concepts);
    END
  `)

  await db.run(sql`
    CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, facts, concepts)
      VALUES ('delete', old.rowid, old.title, old.subtitle, old.narrative, old.facts, old.concepts);
    END
  `)
}
```

### 6.2 Mapeamento afterResponse → Tool Results

O hook `afterResponse` do OpenCode recebe a response completa do LLM. Precisamos filtrar apenas os content blocks que são tool results:

```typescript
// hooks/after-response.ts
export const afterResponseHook = (store: MemoryStore, config: PluginConfig) =>
  async ({ response, sessionId }: AfterResponseContext) => {
    const toolResults = response.content
      .filter((block): block is ToolResultBlock => block.type === "tool_result")

    if (!toolResults.length) return

    const tasks = toolResults.map(async (result) => {
      const rawContent = typeof result.content === "string"
        ? result.content
        : JSON.stringify(result.content)

      if (rawContent.length < 100) return // Skip trivial outputs

      const truncated = rawContent.slice(0, config.maxRawContentSize)

      await store.enqueuePending({
        id: crypto.randomUUID(),
        sessionId,
        toolName: result.toolName ?? "unknown",
        rawContent: config.privacyStrip ? stripSensitiveTokens(truncated) : truncated,
        status: "pending",
        retryCount: 0,
        createdAt: new Date(),
      })
    })

    await Promise.allSettled(tasks)

    // Fire-and-forget: processa queue em background
    queueMicrotask(() => compressionPipeline.processQueue())
  }
```

### 6.3 Estratégia de Background Processing

Em vez de um daemon separado, a compressão roda como microtask dentro do event loop do Bun. O `pending_messages` garante durabilidade:

```
[Tool result chega]
       │
       ▼
[INSERT pending_messages (status: "pending")]  ← crash-safe a partir daqui
       │
       ▼
[queueMicrotask → processQueue()]
       │
       ├── Sucesso → INSERT observation + UPDATE pending status → "processed"
       │
       └── Falha → UPDATE pending status → retry_count++ / "failed" se >= 3

[Próximo startup do plugin]
       │
       ▼
[Verifica pending_messages com status "pending" ou "processing"]
       │
       ▼
[Reprocessa mensagens órfãs]  ← recovery automático
```

### 6.4 Privacy Tag Stripping

Portado de `tag-stripping.ts` do claude-mem, adaptado para padrões genéricos:

```typescript
// compression/privacy.ts
const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*["']?[\w\-./]+["']?/gi,
  /(?:Bearer|Basic)\s+[\w\-./+=]+/g,
  /-----BEGIN\s+[\w\s]+-----[\s\S]*?-----END\s+[\w\s]+-----/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
]

export const stripSensitiveTokens = (content: string) =>
  SENSITIVE_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[REDACTED]"),
    content
  )
```

---

## 7. Preservações e Não-Objetivos

### 7.1 Preservações

- **Compatibilidade com OpenCode core:** O plugin não modifica nenhum arquivo do core. Funciona exclusivamente via plugin SDK (hooks, tools, bus)
- **Database isolation:** Memória vive em database separado (`~/.config/opencode/memory/`), não altera o database de sessões do OpenCode
- **Provider agnostic:** Funciona com qualquer provider configurado no OpenCode sem hardcoded API keys
- **Backward compatible:** Se o plugin for removido, o OpenCode funciona normalmente sem efeitos colaterais

### 7.2 Não-Objetivos (Explicitamente Fora do Escopo)

| Item | Motivo |
|------|--------|
| ChromaDB / vector DB externo | Complexidade operacional excessiva (35GB+ RAM). Substituto futuro: `sqlite-vec` |
| UI/TUI de gerenciamento de memórias | O OpenCode já tem TUI limitada. Gerenciamento via tools do LLM |
| Sync cross-machine / cloud | Adiciona complexidade de auth, conflitos, GDPR. Escopo local |
| Compressão real-time durante streaming | Compressão é pós-tool-execution, não durante streaming |
| Suporte a Claude Code (manter compatibilidade dual) | O port é exclusivo para OpenCode. claude-mem continua existindo para Claude Code |
| Export/import de memórias entre projetos | Pode ser adicionado como feature futura, não faz parte do MVP |

---

## 8. Roadmap de Implementação

### Fase 1 — Scaffold + Storage (1–2 semanas)

- [ ] Setup do package `packages/plugin-memory` no monorepo OpenCode
- [ ] Drizzle schemas para todas as tabelas
- [ ] Migration SQL para FTS5 virtual table + triggers
- [ ] `MemoryStore` com CRUD básico
- [ ] `MemorySearch` com FTS5 queries
- [ ] Testes unitários do storage layer
- [ ] Config schema com defaults

### Fase 2 — Capture Pipeline (2–3 semanas)

- [ ] `afterResponse` hook com extração de tool results
- [ ] `PendingMessageQueue` com enqueue + status tracking
- [ ] `CompressionPipeline` com Vercel AI SDK
- [ ] Prompts de compressão model-agnostic
- [ ] JSON structured output parser com fallback
- [ ] Privacy tag stripping
- [ ] Recovery de mensagens órfãs no startup
- [ ] Testes de integração do pipeline completo

### Fase 3 — Search + Retrieval Tools (1–2 semanas)

- [ ] `memory_search` tool (FTS5)
- [ ] `memory_timeline` tool (cronológico com filtros)
- [ ] `memory_get` tool (batch fetch por IDs)
- [ ] `beforePrompt` hook com context injection
- [ ] `ContextGenerator` com progressive disclosure
- [ ] Testes end-to-end de search + retrieval

### Fase 4 — Session Lifecycle (1 semana)

- [ ] Bus subscriber para `session.created`
- [ ] Bus subscriber para session end detection
- [ ] Session summary generation via AI
- [ ] Flush de pending queue no shutdown
- [ ] Graceful shutdown handler

### Fase 5 (Futura) — Semantic Search

- [ ] Integração com `sqlite-vec`
- [ ] Embedding generation (all-MiniLM-L6-v2 via ONNX)
- [ ] Hybrid search (FTS5 + vector similarity)
- [ ] Benchmark de qualidade de busca FTS5 vs hybrid

---

## 9. Métricas de Qualidade

| Métrica | Target | Como Medir |
|---------|--------|-----------|
| Compression ratio | 10:1 a 100:1 | `raw_token_count / compressed_token_count` por observation |
| Context injection cost | ≤ 2.000 tokens | Contagem de tokens do payload `beforePrompt` |
| Pending queue latency | < 5s (p95) | Diferença entre `created_at` e `processed_at` |
| Crash recovery | 0 mensagens perdidas | Count de `pending` status após restart |
| FTS5 search latency | < 50ms (p95) | Profiling de queries FTS5 |
| Memory DB size | < 100MB para 10k observations | File size do SQLite |
| Plugin load time | < 200ms | Tempo do `setup()` |

---

## 10. Riscos e Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|-------|--------------|---------|-----------|
| OpenCode plugin SDK muda (projeto jovem, v0.2.x) | Alta | Alto | Abstrair interações com SDK atrás de interfaces. Monitorar releases |
| Modelo pequeno produz compressão de baixa qualidade | Média | Médio | Fallback para modelo maior. Retry com prompt ajustado. Métricas de qualidade |
| FTS5 insuficiente para buscas complexas | Média | Médio | sqlite-vec como upgrade path planejado (Fase 5) |
| Concorrência no SQLite (múltiplas sessões) | Baixa | Médio | WAL mode + busy_timeout. Apenas um writer por vez |
| Tool outputs muito grandes excedem limites do modelo | Média | Baixo | Truncation configurável (`maxRawContentSize`). Chunking para outputs > 50k |
| Rate limiting do provider durante batch compression | Média | Baixo | Fila com backoff exponencial. Configuração de batch size |
