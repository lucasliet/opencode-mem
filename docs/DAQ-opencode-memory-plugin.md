# DAQ — Documento de Arquitetura e Qualidade
## Plugin de Memória Persistente Cross-Session para OpenCode
### Portabilidade do claude-mem → `@opencode-ai/plugin-memory`

**Versão:** 1.1.0  
**Data:** 2026-03-18  
**Status:** Implementado (MVP + hardening)  
**Autor:** Lucas

---

## 1. Objetivo

Adicionar memória persistente entre sessões no OpenCode para reduzir repetição de contexto, permitindo que o agente recupere histórico de decisões, erros, mudanças e resumos de sessão por projeto.

---

## 2. Escopo implementado (estado atual)

### 2.1 Captura e persistência

- Captura de outputs de tools via hook `tool.execute.after`
- Fila crash-safe em `pending_messages`
- Compressão assíncrona in-process
- Persistência em SQLite + índice FTS5
- Isolamento por projeto (`project_id`, `project_root`)

### 2.2 Contexto cross-session

- Injeção automática de contexto no system prompt via `experimental.chat.system.transform`
- Contexto inclui:
  - índice de observações recentes
  - amostras detalhadas
  - resumos de sessões recentes
- Preservação de highlights durante compaction via `experimental.session.compacting`

### 2.3 Memória além de tool calls

- Captura de prompts do usuário via `chat.message`
- Geração de `session_summaries` usando observações + prompts
- Trigger de sumarização em eventos `session.idle` e `session.compacted`

### 2.4 Ferramentas de memória disponíveis

- `memory_search`
- `memory_timeline`
- `memory_get`
- `memory_forget`
- `memory_stats`

---

## 3. Decisões arquiteturais finais

| # | Decisão | Resultado |
|---|---|---|
| A1 | In-process (sem sidecar) | Menor complexidade operacional |
| A2 | SQLite + FTS5 only | Sem dependências pesadas externas |
| A3 | Compressão assíncrona com fila durável | Recuperação de orfãos e crash-safety |
| A4 | Projeto como fronteira de isolamento | Sem mistura de memórias entre repositórios |
| A5 | Progressive disclosure | Busca compacta → timeline → fetch completo |
| A6 | Quality gate com `high/medium/low` | Controle de confiança + `rawFallback` |
| A7 | Observabilidade nativa | `memory_stats`, `tool_usage_stats`, `deletion_log` |
| A8 | Fluxo de deleção com confirmação explícita | `memory_forget` com preview + token de confirmação |

---

## 4. Hooks reais do SDK usados

Mapeamento final (OpenCode SDK v1.2.x):

| Hook/Event | Papel |
|---|---|
| `tool.execute.after` | Captura output de tools e enfileira compressão |
| `experimental.chat.system.transform` | Injeta memória cross-session no system prompt |
| `chat.message` | Persiste prompts do usuário |
| `event` | Lifecycle de sessão (`created`, `idle`, `compacted`, `deleted`) |
| `experimental.session.compacting` | Injeta anchors de memória no processo de compaction |

---

## 5. Arquitetura final da solução

```text
OpenCode Server (Bun)
└─ @opencode-ai/plugin-memory
   ├─ Hooks
   │  ├─ tool.execute.after
   │  ├─ experimental.chat.system.transform
   │  ├─ chat.message
   │  ├─ event
   │  └─ experimental.session.compacting
   ├─ Compression Pipeline (async)
   │  ├─ pending_messages -> processing
   │  ├─ compressor (provider/modelo atual)
   │  ├─ parser + quality gate
   │  └─ observations + rawFallback
   ├─ MemoryStore (Drizzle + SQL)
   ├─ Tools
   │  ├─ memory_search
   │  ├─ memory_timeline
   │  ├─ memory_get
   │  ├─ memory_forget
   │  └─ memory_stats
   └─ SQLite (~/.config/opencode/memory/memory.db)
      └─ FTS5 + triggers
```

---

## 6. Estrutura real do código

```text
src/
├── index.ts
├── config.ts
├── types.ts
├── utils.ts
├── logger.ts
├── hooks/
│   ├── tool-after.ts
│   ├── system-transform.ts
│   ├── chat-message.ts
│   ├── events.ts
│   └── compaction.ts
├── compression/
│   ├── pipeline.ts
│   ├── compressor.ts
│   ├── parser.ts
│   ├── prompts.ts
│   ├── privacy.ts
│   └── quality.ts
├── context/
│   └── generator.ts
├── storage/
│   ├── db.ts
│   ├── schema.ts
│   └── store.ts
└── tools/
    ├── memory-search.ts
    ├── memory-timeline.ts
    ├── memory-get.ts
    ├── memory-forget.ts
    └── memory-stats.ts
```

---

## 7. Modelo de dados final

### 7.1 Tabelas

1. `observations`  
   Campos relevantes: `quality`, `raw_fallback`, `project_id`, `project_root`

2. `pending_messages`  
   Fila de compressão (`pending`, `processing`, `processed`, `failed`)

3. `session_summaries`  
   Resumos de sessão gerados por IA

4. `user_prompts`  
   Prompts do usuário capturados por `chat.message`

5. `deletion_log`  
   Auditoria de operações de deleção

6. `tool_usage_stats`  
   Contadores por sessão/tool para observabilidade

### 7.2 Busca textual

- Virtual table `observations_fts` (FTS5)
- Triggers `INSERT/UPDATE/DELETE` para sincronização automática

---

## 8. Fluxo de dados implementado

1. Usuário interage com o agente
2. `tool.execute.after` captura output relevante
3. Output entra em `pending_messages`
4. Pipeline assíncrono comprime, valida qualidade e persiste `observations`
5. Em `session.idle` ou `session.compacted`, o plugin gera/atualiza `session_summaries`
6. Em nova sessão, `experimental.chat.system.transform` injeta memória recente no system prompt
7. Se necessário, o agente usa `memory_search`/`memory_timeline`/`memory_get` para recuperação incremental

---

## 9. Segurança e governança de deleção

### 9.1 `memory_forget`

Fluxo final de deleção:

1. Preview obrigatório (`confirm` ausente ou `false`)
2. Retorno com `confirmationToken`
3. Execução só com `confirm=true` + `confirmationToken`
4. Bloqueio de confirmação no mesmo turno
5. Expiração de token e validação de critérios
6. Auditoria em `deletion_log`

Objetivo: impedir deleção autônoma sem confirmação explícita do usuário.

---

## 10. Qualidade da memória

### 10.1 Quality gate

- Classificação: `high`, `medium`, `low`
- `low` recebe `rawFallback` para recuperação contextual em `memory_get`
- `memory_search` marca entradas `low` com `[?]`

### 10.2 Observabilidade

`memory_stats` expõe:

- total de observações
- distribuição por qualidade
- status da fila
- taxa média de compressão
- uso de tools
- deleções recentes
- tamanho do banco

---

## 11. Restrições críticas de inicialização

Durante plugin init, não chamar SDK APIs (`client.*`).  
Init usa apenas I/O local (filesystem/env/SQLite) e retorna hooks rapidamente.

Razão: evitar deadlock do OpenCode enquanto aguarda o retorno da definição do plugin.

---

## 12. Estado de implementação vs DAQ original

### 12.1 Concluído

- arquitetura in-process
- SQLite + FTS5
- captura de tool outputs
- captura de prompts de usuário
- sumarização de sessão
- injeção automática de contexto
- ferramentas de busca/linha do tempo/fetch/deleção/stats
- quality gate e raw fallback
- logs de deleção e estatísticas de uso

### 12.2 Fora do escopo atual

- busca semântica (`sqlite-vec`)
- sync cloud/cross-machine
- UI dedicada de administração

---

## 13. Operação local

### 13.1 Instalação no OpenCode global

```json
{
  "plugin": ["@opencode-ai/plugin-memory"]
}
```

### 13.2 Ciclo de desenvolvimento

```bash
bun install
bun run typecheck
bun test
bun run build
```

Após `build`, reiniciar o OpenCode para recarregar `dist/index.js`.

---

## 14. Referências de implementação

- Entry point e registro de hooks/tools: `src/index.ts`
- Captura de tools: `src/hooks/tool-after.ts`
- Captura de prompts: `src/hooks/chat-message.ts`
- Injeção de contexto: `src/hooks/system-transform.ts` e `src/context/generator.ts`
- Lifecycle e summaries: `src/hooks/events.ts`
- Pipeline de compressão: `src/compression/pipeline.ts`
- Quality gate: `src/compression/quality.ts`
- Schema: `src/storage/schema.ts`
- Persistência e buscas: `src/storage/store.ts`
- Deleção segura: `src/tools/memory-forget.ts`

---

## 15. Próximos passos recomendados

1. Benchmark formal de latência e precisão de recuperação
2. Evolução para busca híbrida (FTS5 + vetorial)
3. Políticas de retenção mais granulares por tipo de observação
