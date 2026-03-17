import { Database } from "bun:sqlite"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import type { schema } from "./schema"
import { ensureParentDirectory } from "../utils"

export interface MemoryDatabase {
  sqlite: Database
  db: BunSQLiteDatabase<typeof schema>
}

/**
 * Creates the SQLite database and ensures the schema exists.
 *
 * @param dbPath - SQLite file path.
 * @returns The initialized SQLite client and Drizzle database.
 */
export async function createMemoryDatabase(dbPath: string): Promise<MemoryDatabase> {
  await ensureParentDirectory(dbPath)

  const sqlite = new Database(dbPath, { create: true })
  sqlite.exec("PRAGMA journal_mode = WAL;")
  sqlite.exec("PRAGMA busy_timeout = 5000;")
  sqlite.exec("PRAGMA foreign_keys = ON;")

  ensureSchema(sqlite)

  return {
    sqlite,
    db: drizzle({ client: sqlite }),
  }
}

/**
 * Ensures that all regular tables, indexes, and FTS objects exist.
 *
 * @param sqlite - Raw SQLite client.
 * @returns Nothing.
 */
export function ensureSchema(sqlite: Database): void {
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
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS observations_project_created_idx
      ON observations(project_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS observations_session_idx
      ON observations(session_id);

    CREATE INDEX IF NOT EXISTS observations_type_idx
      ON observations(type);

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
  `)

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

  sqlite.exec(`INSERT INTO observations_fts(observations_fts) VALUES('rebuild');`)
}
