import { Database } from "bun:sqlite"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import type { schema } from "./schema"
import { load as loadSqliteVec } from "sqlite-vec"
import type { PluginConfig, VectorBackendState } from "../types"
import { ensureParentDirectory } from "../utils"

export interface MemoryDatabase {
  sqlite: Database
  db: BunSQLiteDatabase<typeof schema>
  vector: VectorBackendState
}

/**
 * Creates the SQLite database and ensures the schema exists.
 *
 * @param config - Plugin configuration.
 * @returns The initialized SQLite client and Drizzle database.
 */
export async function createMemoryDatabase(config: PluginConfig): Promise<MemoryDatabase> {
  await ensureParentDirectory(config.dbPath)

  const sqlite = new Database(config.dbPath, { create: true })
  sqlite.exec("PRAGMA journal_mode = WAL;")
  sqlite.exec("PRAGMA busy_timeout = 5000;")
  sqlite.exec("PRAGMA foreign_keys = ON;")

  const vector = ensureSchema(sqlite, config)

  return {
    sqlite,
    db: drizzle({ client: sqlite }),
    vector,
  }
}

/**
 * Ensures that all regular tables, indexes, and FTS objects exist.
 *
 * @param sqlite - Raw SQLite client.
 * @param config - Plugin configuration.
 * @returns Vector backend state.
 */
export function ensureSchema(sqlite: Database, config: PluginConfig): VectorBackendState {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      narrative TEXT NOT NULL,
      facts TEXT NOT NULL DEFAULT '[]',
      concepts TEXT NOT NULL DEFAULT '[]',
      files_involved TEXT NOT NULL DEFAULT '[]',
      raw_token_count INTEGER NOT NULL DEFAULT 0,
      compressed_token_count INTEGER NOT NULL DEFAULT 0,
      tool_name TEXT,
      model_used TEXT,
      quality TEXT NOT NULL DEFAULT 'high',
      raw_fallback TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS observations_project_created_idx
      ON observations(project_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS observations_session_idx
      ON observations(session_id);

    CREATE INDEX IF NOT EXISTS observations_type_idx
      ON observations(type);

    CREATE INDEX IF NOT EXISTS observations_quality_idx
      ON observations(quality);

    CREATE TABLE IF NOT EXISTS observation_embeddings (
      observation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding_dimensions INTEGER NOT NULL,
      embedding_input TEXT NOT NULL,
      embedding_vector TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS observation_embeddings_project_created_idx
      ON observation_embeddings(project_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS observation_embeddings_model_idx
      ON observation_embeddings(embedding_model);

    CREATE TABLE IF NOT EXISTS session_summaries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      session_id TEXT NOT NULL,
      requested TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      observation_count INTEGER NOT NULL DEFAULT 0,
      model_used TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS session_summaries_session_unique_idx
      ON session_summaries(project_id, session_id);

    CREATE INDEX IF NOT EXISTS session_summaries_created_idx
      ON session_summaries(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS pending_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      title TEXT,
      raw_content TEXT NOT NULL,
      raw_metadata TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      processed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS pending_messages_status_created_idx
      ON pending_messages(project_id, status, created_at ASC);

    CREATE INDEX IF NOT EXISTS pending_messages_session_idx
      ON pending_messages(session_id);

    CREATE TABLE IF NOT EXISTS user_prompts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS user_prompts_message_unique_idx
      ON user_prompts(message_id);

    CREATE INDEX IF NOT EXISTS user_prompts_session_idx
      ON user_prompts(project_id, session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS deletion_log (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      criteria TEXT NOT NULL,
      count INTEGER NOT NULL,
      initiator TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS deletion_log_timestamp_idx
      ON deletion_log(project_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS tool_usage_stats (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      call_count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS tool_usage_stats_session_tool_idx
      ON tool_usage_stats(project_id, session_id, tool_name);
  `)

  try {
    sqlite.exec("ALTER TABLE observations ADD COLUMN quality TEXT NOT NULL DEFAULT 'high';")
  } catch {
    void 0
  }

  try {
    sqlite.exec("ALTER TABLE observations ADD COLUMN raw_fallback TEXT;")
  } catch {
    void 0
  }

  try {
    sqlite.exec("ALTER TABLE observation_embeddings ADD COLUMN embedding_vector TEXT NOT NULL DEFAULT '[]';")
  } catch {
    void 0
  }

  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      title,
      subtitle,
      narrative,
      facts,
      concepts,
      files_involved,
      content='observations',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS observations_ai
    AFTER INSERT ON observations
    BEGIN
      INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts, files_involved)
      VALUES (new.rowid, new.title, new.subtitle, new.narrative, new.facts, new.concepts, new.files_involved);
    END;

    CREATE TRIGGER IF NOT EXISTS observations_ad
    AFTER DELETE ON observations
    BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, facts, concepts, files_involved)
      VALUES ('delete', old.rowid, old.title, old.subtitle, old.narrative, old.facts, old.concepts, old.files_involved);
    END;

    CREATE TRIGGER IF NOT EXISTS observations_au
    AFTER UPDATE ON observations
    BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, facts, concepts, files_involved)
      VALUES ('delete', old.rowid, old.title, old.subtitle, old.narrative, old.facts, old.concepts, old.files_involved);
      INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts, files_involved)
      VALUES (new.rowid, new.title, new.subtitle, new.narrative, new.facts, new.concepts, new.files_involved);
    END;
  `)

  return ensureVectorSchema(sqlite, config)
}

/**
 * Loads sqlite-vec and creates vector structures when possible.
 *
 * @param sqlite - Raw SQLite client.
 * @param config - Plugin configuration.
 * @returns Vector backend state.
 */
export function ensureVectorSchema(sqlite: Database, config: PluginConfig): VectorBackendState {
  if (!config.enableSemanticSearch) {
    return {
      enabled: false,
      available: false,
      dimensions: config.embeddingDimensions,
      error: null,
    }
  }

  const disabledState: VectorBackendState = {
    enabled: true,
    available: false,
    dimensions: config.embeddingDimensions,
    error: null,
  }

  try {
    loadSqliteVec(sqlite)
  } catch (error) {
    return {
      ...disabledState,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const existingDefinition = sqlite
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observation_embeddings_vec'")
    .get() as { sql: string | null } | null

  if (existingDefinition?.sql && !existingDefinition.sql.includes(`float[${config.embeddingDimensions}]`)) {
    return {
      ...disabledState,
      error: `Existing vector table dimension mismatch for ${config.embeddingDimensions}`,
    }
  }

  try {
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observation_embeddings_vec USING vec0(
        observation_id TEXT,
        project_id TEXT,
        type TEXT,
        quality TEXT,
        created_at INTEGER,
        embedding float[${config.embeddingDimensions}] distance_metric=cosine
      );
    `)
  } catch (error) {
    return {
      ...disabledState,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  return {
    enabled: config.enableSemanticSearch,
    available: true,
    dimensions: config.embeddingDimensions,
    error: null,
  }
}
