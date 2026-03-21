import { desc, eq } from "drizzle-orm"
import { personaMemory, type PersonaMemoryRow } from "./schema"
import type { MemoryDatabase } from "./db"
import type { PersonaMemory } from "../types"
import { createSortableId } from "../utils"

/**
 * Persists and retrieves the global user persona memory.
 */
export class PersonaStore {
  constructor(
    private readonly database: MemoryDatabase,
    private readonly now: () => number,
  ) {}

  /**
   * Retrieves the current persona memory entry.
   *
   * @returns The persona memory or null if none exists.
   */
  async getPersona(): Promise<PersonaMemory | null> {
    const row = this.database.db
      .select()
      .from(personaMemory)
      .orderBy(desc(personaMemory.updatedAt))
      .get()

    return row ? mapPersonaMemory(row) : null
  }

  /**
   * Creates or replaces the persona memory content.
   *
   * @param content - New persona content.
   * @returns The updated persona memory.
   */
  async updatePersona(content: string): Promise<PersonaMemory> {
    const existing = await this.getPersona()
    const now = this.now()

    if (existing) {
      this.database.db
        .update(personaMemory)
        .set({
          content,
          version: existing.version + 1,
          updatedAt: now,
        })
        .where(eq(personaMemory.id, existing.id))
        .run()

      return {
        ...existing,
        content,
        version: existing.version + 1,
        updatedAt: now,
      }
    }

    const id = createSortableId(this.now)
    this.database.db
      .insert(personaMemory)
      .values({
        id,
        content,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    return { id, content, version: 1, createdAt: now, updatedAt: now }
  }

  /**
   * Merges new facts into the existing persona content.
   *
   * @param newFacts - Array of new facts to merge.
   * @returns The updated persona memory.
   */
  async mergeFacts(newFacts: string[]): Promise<PersonaMemory> {
    const existing = await this.getPersona()
    const now = this.now()

    if (!existing) {
      const content = newFacts.join("\n")
      const id = createSortableId(this.now)

      this.database.db
        .insert(personaMemory)
        .values({
          id,
          content,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run()

      return { id, content, version: 1, createdAt: now, updatedAt: now }
    }

    const existingLines = existing.content.split("\n").filter(Boolean)
    const existingSet = new Set(existingLines.map((line) => line.trim().toLowerCase()))

    const merged = [...existingLines]
    for (const fact of newFacts) {
      const normalized = fact.trim()
      if (normalized && !existingSet.has(normalized.toLowerCase())) {
        merged.push(normalized)
        existingSet.add(normalized.toLowerCase())
      }
    }

    const content = merged.join("\n")
    if (content === existing.content) {
      return existing
    }

    this.database.db
      .update(personaMemory)
      .set({
        content,
        version: existing.version + 1,
        updatedAt: now,
      })
      .where(eq(personaMemory.id, existing.id))
      .run()

    return {
      ...existing,
      content,
      version: existing.version + 1,
      updatedAt: now,
    }
  }

  /**
   * Clears the persona memory content.
   *
   * @returns A promise that resolves after clearing.
   */
  async clearPersona(): Promise<void> {
    const existing = await this.getPersona()
    if (!existing) {
      return
    }

    this.database.db
      .delete(personaMemory)
      .where(eq(personaMemory.id, existing.id))
      .run()
  }
}

/**
 * Maps a persona memory row into the runtime shape.
 *
 * @param row - Database row.
 * @returns Normalized persona memory.
 */
export function mapPersonaMemory(row: PersonaMemoryRow): PersonaMemory {
  return {
    id: row.id,
    content: row.content,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
