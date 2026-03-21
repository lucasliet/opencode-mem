# DAQ — Documento de Arquitetura e Qualidade
## Plugin de Memória Persistente Cross-Session para OpenCode
### Portabilidade do claude-mem -> `opencode-memory-plugin`

**Versão:** 1.3.0
**Data:** 2026-03-21
**Status:** Implementado no core textual; arquitetura híbrida aprovada e em rollout  
**Autor:** Lucas

---

## 1. Objetivo

Adicionar memória persistente entre sessões no OpenCode para reduzir repetição de contexto, permitindo que o agente recupere histórico de decisões, erros, mudanças e resumos de sessão por projeto. A evolução atual adiciona busca semântica local-only com embeddings locais e `sqlite-vec`, preservando o desenho in-process, o progressive disclosure e a governança lexical já implementados.

---

## 2. Escopo atual e alvo arquitetural

### 2.1 Implementado hoje

- Captura de outputs de tools via `tool.execute.after`
- Fila crash-safe em `pending_messages`
- Compressão assíncrona in-process
- Persistência em SQLite com índice FTS5
- Isolamento por projeto (`project_id`, `project_root`)
- Injeção automática de contexto via `experimental.chat.system.transform`
- Captura de prompts via `chat.message`
- Resumos de sessão em `session_summaries`
- Progressive disclosure com `memory_search`, `memory_timeline`, `memory_get`
- Deleção governada com preview + token de confirmação em `memory_forget`
- Gravação deliberada via `memory_add` (persistência direta pelo agente, quality alta, bypass do pipeline)

### 2.2 Alvo aprovado para esta fase

- Manter FTS5 como base obrigatória para busca lexical, governança e fallback
- Adicionar embeddings locais com warmup tardio e cache local
- Adicionar armazenamento vetorial local com `sqlite-vec`
- Expor recuperação híbrida `FTS5 + sqlite-vec` em `memory_search`
- Enriquecer a injeção automática de contexto com amostra semântica conservadora
- Preservar fallback automático para comportamento textual quando semântica estiver desabilitada ou indisponível

---

## 3. Decisões arquiteturais finais

| # | Decisão | Resultado |
|---|---|---|
| A1 | In-process (sem sidecar) | Menor complexidade operacional |
| A2 | SQLite + FTS5 continuam obrigatórios | Busca lexical, fallback e governança permanecem locais |
| A3 | Backend vetorial prioritário `sqlite-vec` | Busca semântica local-only no mesmo banco |
| A4 | Embeddings locais com warmup tardio | Sem chamadas remotas e sem custo externo |
| A5 | Compressão textual e embeddings em ciclos separados | Falha vetorial nao bloqueia persistência textual |
| A6 | Projeto como fronteira de isolamento | Sem mistura de memórias entre repositórios |
| A7 | Progressive disclosure | Busca compacta -> timeline -> fetch completo |
| A8 | Quality gate com `high/medium/low` | Controle de confiança + `rawFallback` |
| A9 | Fluxo de deleção com confirmação explícita | Preview + token + auditoria |
| A10 | Fallback degradado quando `sqlite-vec` falhar | Preferir busca semântica por `sqlite-vec`; usar fallback JS sobre embeddings persistidos e manter FTS5 como base lexical |

---

## 4. Restrições críticas

1. Não chamar nenhuma SDK API `client.*` durante plugin init.
2. Semântica deve ser local-only: sem API remota para geração de embeddings.
3. `memory_forget` permanece lexical/FTS na fase inicial.
4. FTS5 não pode ser removido nem substituído pelo backend vetorial.
5. Falha de embeddings não pode impedir gravação textual nem sumarização.
6. Ranking híbrido deve penalizar observações `low` e preservar desempate temporal.

---

## 5. Hooks reais do SDK usados

Mapeamento final (OpenCode SDK v1.2.x):

| Hook/Event | Papel |
|---|---|
| `tool.execute.after` | Captura output de tools e enfileira compressão |
| `experimental.chat.system.transform` | Injeta memória cross-session no system prompt |
| `chat.message` | Persiste prompts do usuário |
| `event` | Lifecycle de sessão (`created`, `idle`, `compacted`, `deleted`) |
| `experimental.session.compacting` | Injeta anchors de memória no processo de compaction |

---

## 6. Arquitetura alvo da solução

```text
OpenCode Server (Bun)
└─ opencode-memory-plugin
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
   │  ├─ observations + rawFallback
   │  └─ embedding stage (best-effort, post-persist)
   ├─ Embeddings
   │  ├─ embedding text builder
   │  ├─ local embedding provider
   │  └─ availability + health state
   ├─ MemoryStore (Drizzle + SQL)
   │  ├─ FTS5 search
   │  ├─ semantic search (sqlite-vec)
   │  └─ hybrid ranking
   ├─ Tools
    │  ├─ memory_search
    │  ├─ memory_timeline
    │  ├─ memory_get
    │  ├─ memory_add
    │  ├─ memory_forget
    │  └─ memory_stats
   └─ SQLite (~/.config/opencode/memory/memory.db)
      ├─ core tables
      ├─ observations_fts + triggers
      └─ sqlite-vec structures for observation embeddings
```

---

## 7. Estrutura real do código

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
├── embeddings/
│   ├── provider.ts
│   ├── local-provider.ts
│   ├── text.ts
│   └── types.ts
├── storage/
│   ├── db.ts
│   ├── schema.ts
│   ├── store.ts
│   └── vector.ts
└── tools/
    ├── memory-search.ts
    ├── memory-timeline.ts
    ├── memory-get.ts
    ├── memory-add.ts
    ├── memory-forget.ts
    └── memory-stats.ts
```

Os módulos em `src/embeddings/` e `src/storage/vector.ts` representam o alvo arquitetural desta fase e podem ser introduzidos incrementalmente ao longo do rollout.

---

## 8. Modelo de dados

### 8.1 Tabelas principais

1. `observations`  
   Memória textual compactada com `quality`, `raw_fallback`, `project_id`, `project_root`

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

### 8.2 Índices de busca

- `observations_fts` (FTS5) continua sendo a camada lexical principal
- Triggers `INSERT/UPDATE/DELETE` mantêm sincronização automática
- Estruturas vetoriais dedicadas armazenam embeddings por `observation_id`
- Metadados mínimos do embedding incluem `project_id`, `embedding_model`, `embedding_dimensions`, `embedding_input`, timestamps e estado de disponibilidade

### 8.3 Política de lifecycle

- Exclusão de observação remove também os embeddings associados
- Retention cleanup remove linhas textuais e vetoriais juntas
- Vetores órfãos devem ser tratados por limpeza explícita e testes de regressão

---

## 9. Fluxo de dados alvo

1. Usuário interage com o agente
2. `tool.execute.after` captura output relevante
3. Output entra em `pending_messages`
4. Pipeline assíncrono comprime, valida qualidade e persiste `observations`
5. Em etapa posterior e best-effort, o pipeline gera embeddings locais para observações elegíveis
6. O store persiste o vetor em estruturas dedicadas do `sqlite-vec`
7. Em nova sessão, `experimental.chat.system.transform` injeta contexto recente e, se habilitado, contexto semântico conservador
8. `memory_search` usa ranking híbrido quando disponível; caso contrário, volta para FTS-only
9. `memory_get` continua sendo a expansão detalhada, inclusive para memórias descobertas semanticamente

Caminho alternativo de escrita:

- `memory_add` permite ao agente persistir diretamente observações com quality `high`, bypassando o pipeline de compressão. Útil para decisões explícitas e contexto importante que o agente julga digno de persistência.

---

## 10. Busca híbrida

### 10.1 Princípios

- FTS5 permanece fonte primária de governança e fallback
- Semântica entra como reforço de recall e relevância
- Busca híbrida deve ser restrita por `project_id`
- Memórias `low` sofrem penalidade de ranking
- Desempate final usa recência

### 10.2 Estratégia de ranking

O ranking híbrido combina:

- score lexical (BM25/FTS)
- score vetorial (`sqlite-vec`)
- penalidade por `quality=low`
- desempate temporal

Quando semântica estiver desabilitada, indisponível ou sem embeddings suficientes, o store degrada automaticamente para `searchFTS()` sem alterar a interface pública.

---

## 11. Contexto cross-session

### 11.1 Sessão ativa

`experimental.chat.system.transform` deve combinar, com orçamento controlado:

1. observações recentes
2. observações semanticamente relevantes ao prompt atual
3. resumos de sessão recentes

### 11.2 Guardrails

- limite pequeno para memórias semânticas
- preferência por qualidade `high` e `medium`
- fallback automático para o comportamento atual se a busca vetorial falhar
- `memory_get` continua como caminho detalhado para expandir contexto quando necessário

---

## 12. Segurança e governança de deleção

### 12.1 `memory_forget`

Fluxo final de deleção:

1. Preview obrigatório (`confirm` ausente ou `false`)
2. Retorno com `confirmationToken`
3. Execução só com `confirm=true` + `confirmationToken`
4. Bloqueio de confirmação no mesmo turno
5. Expiração de token e validação de critérios
6. Auditoria em `deletion_log`
7. Remoção conjunta de embeddings associados às observações apagadas

Objetivo: impedir deleção autônoma sem confirmação explícita do usuário e evitar lixo vetorial órfão.

---

## 13. Qualidade, observabilidade e fallback

### 13.1 Quality gate

- Classificação: `high`, `medium`, `low`
- `low` recebe `rawFallback` para recuperação contextual em `memory_get`
- `memory_search` continua marcando entradas `low` com `[?]`
- Ranking híbrido deve considerar a qualidade como penalidade ou priorização

### 13.2 Observabilidade

`memory_stats` deve expor:

- total de observações
- distribuição por qualidade
- status da fila textual
- total de observações com embedding
- cobertura vetorial percentual
- modelo de embedding ativo
- dimensão vetorial
- falhas recentes da etapa vetorial
- uso de tools
- deleções recentes
- tamanho do banco

### 13.3 Fallback operacional

- se o provider local não carregar, seguir com persistência textual
- se `sqlite-vec` não estiver disponível no runtime, seguir com fallback semântico em JS sobre embeddings persistidos e manter FTS5 como base lexical
- se a geração de embedding falhar para uma observação, não invalidar a observação textual

---

## 14. Restrições críticas de inicialização

Durante plugin init, não chamar SDK APIs (`client.*`).  
Init usa apenas I/O local (filesystem/env/SQLite) e retorna hooks rapidamente.

Razão: evitar deadlock do OpenCode enquanto aguarda o retorno da definição do plugin.

Warmup de embeddings, leitura de config runtime do OpenCode e chamadas de modelo devem ocorrer apenas depois que o plugin já tiver retornado seus hooks.

---

## 15. Estado de implementação vs arquitetura 1.3

### 15.1 Concluído

- arquitetura in-process
- SQLite + FTS5
- captura de tool outputs
- captura de prompts de usuário
- sumarização de sessão
- injeção automática de contexto por recência
- ferramentas de busca/linha do tempo/fetch/deleção/stats
- gravação deliberada via `memory_add`
- quality gate e raw fallback
- logs de deleção e estatísticas de uso

### 15.2 Em rollout

- config explícita para embeddings e busca híbrida
- storage vetorial com `sqlite-vec`
- geração local de embeddings em etapa assíncrona separada
- `MemoryStore.searchHybrid()` com preferencia por `sqlite-vec` e fallback JS quando `loadExtension()` não estiver disponível
- recuperação semântica em `memory_search`
- contexto automático com complemento semântico conservador

### 15.3 Fora do escopo desta fase

- sync cloud/cross-machine
- UI dedicada de administração
- deleção semântica
- web server local dedicado

---

## 16. Operação local

### 16.1 Instalação no OpenCode global

```json
{
  "plugin": ["opencode-memory-plugin"]
}
```

### 16.2 Ciclo de desenvolvimento

```bash
bun install
bun run typecheck
bun test
bun run build
```

Após `build`, reiniciar o OpenCode para recarregar `dist/index.js`.

---

## 17. Referências de implementação

- Entry point e wiring: `src/index.ts`
- Config e defaults: `src/config.ts`
- Tipos compartilhados: `src/types.ts`
- Captura de tools: `src/hooks/tool-after.ts`
- Captura de prompts: `src/hooks/chat-message.ts`
- Injeção de contexto: `src/hooks/system-transform.ts` e `src/context/generator.ts`
- Lifecycle e summaries: `src/hooks/events.ts`
- Pipeline de compressão: `src/compression/pipeline.ts`
- Quality gate: `src/compression/quality.ts`
- Schema e init DB: `src/storage/schema.ts` e `src/storage/db.ts`
- Persistência e buscas: `src/storage/store.ts`
- Deleção segura: `src/tools/memory-forget.ts`
- Gravação deliberada: `src/tools/memory-add.ts`
- Busca híbrida: `src/tools/memory-search.ts`
- Observabilidade: `src/tools/memory-stats.ts`

---

## 18. Próximos passos mandatórios

1. Introduzir config explícita de embeddings e busca híbrida
2. Integrar `sqlite-vec` com fallback claro para FTS-only
3. Implementar provider local de embeddings com warmup tardio
4. Gerar embeddings em etapa assíncrona pós-persistência textual
5. Atualizar `memory_search` e `generateSessionContext()` para usar recuperação híbrida
6. Validar lifecycle de deleção, retenção e observabilidade vetorial
