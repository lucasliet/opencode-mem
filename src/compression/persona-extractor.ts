import { generateText } from "ai"
import type { PluginInput } from "@opencode-ai/plugin"
import type { RuntimeState } from "../types"
import {
  PERSONA_EXTRACTOR_SYSTEM_PROMPT,
  PERSONA_EXTRACTION_PROMPT,
  PERSONA_MAX_LENGTH,
  PERSONA_SUMMARIZE_THRESHOLD,
} from "./persona-prompts"
import { parseJsonValue } from "../utils"

/**
 * Extracts persona facts from conversation turns.
 */
export class PersonaExtractor {
  constructor(
    private readonly input: PluginInput,
    private readonly state: RuntimeState,
  ) {}

  /**
   * Extracts new persona facts from a conversation turn.
   *
   * @param input - Extraction input.
   * @returns Array of new facts.
   */
  async extract(input: {
    userMessage: string
    assistantMessage: string
    currentPersona: string
    abortSignal?: AbortSignal
  }): Promise<string[]> {
    if (!input.userMessage.trim() || !input.assistantMessage.trim()) {
      return []
    }

    if (input.currentPersona.length > PERSONA_MAX_LENGTH) {
      return []
    }

    const prompt = PERSONA_EXTRACTION_PROMPT
      .replace("{current_persona}", input.currentPersona || "(empty)")
      .replace("{user_message}", input.userMessage.slice(0, 2000))
      .replace("{assistant_message}", input.assistantMessage.slice(0, 2000))

    try {
      const created = await this.input.client.session.create({
        query: { directory: this.input.directory },
        body: { title: "[plugin-memory] persona extraction" },
      })

      if (created.error || !created.data) {
        return []
      }

      const sessionId = created.data.id
      this.state.internalSessionIds.add(sessionId)

      try {
        const response = await this.input.client.session.prompt({
          query: { directory: this.input.directory },
          path: { id: sessionId },
          body: {
            system: PERSONA_EXTRACTOR_SYSTEM_PROMPT,
            parts: [{ type: "text", text: prompt }],
          },
        })

        if (response.error || !response.data) {
          return []
        }

        const text = response.data.parts
          .filter((part): part is import("@opencode-ai/sdk").TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim()

        if (!text) {
          return []
        }

        return this.parseFacts(text)
      } finally {
        await this.input.client.session.delete({
          query: { directory: this.input.directory },
          path: { id: sessionId },
        })
        this.state.internalSessionIds.delete(sessionId)
      }
    } catch {
      return []
    }
  }

  /**
   * Parses extracted facts from the model response.
   *
   * @param raw - Raw model output.
   * @returns Array of facts.
   */
  private parseFacts(raw: string): string[] {
    const parsed = parseJsonValue<string[]>(raw, [])
    if (Array.isArray(parsed)) {
      return parsed.filter((fact) => typeof fact === "string" && fact.trim().length > 0)
    }

    const lines = raw
      .split("\n")
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter((line) => line.length > 10 && !line.startsWith("{") && !line.startsWith("}"))

    return lines.length > 0 ? lines : []
  }

  /**
   * Summarizes a persona that has grown too large.
   *
   * @param content - Current persona content.
   * @returns Summarized persona content.
   */
  async summarize(content: string): Promise<string> {
    if (content.length <= PERSONA_MAX_LENGTH) {
      return content
    }

    const prompt = `Summarize the following user persona into a concise, structured format. Keep the most important preferences, patterns, and context. Remove redundant or outdated information.

User Persona:
${content}

Summarized persona:`

    try {
      const created = await this.input.client.session.create({
        query: { directory: this.input.directory },
        body: { title: "[plugin-memory] persona summarization" },
      })

      if (created.error || !created.data) {
        return content.slice(0, PERSONA_MAX_LENGTH)
      }

      const sessionId = created.data.id
      this.state.internalSessionIds.add(sessionId)

      try {
        const response = await this.input.client.session.prompt({
          query: { directory: this.input.directory },
          path: { id: sessionId },
          body: {
            system: PERSONA_EXTRACTOR_SYSTEM_PROMPT,
            parts: [{ type: "text", text: prompt }],
          },
        })

        if (response.error || !response.data) {
          return content.slice(0, PERSONA_MAX_LENGTH)
        }

        const text = response.data.parts
          .filter((part): part is import("@opencode-ai/sdk").TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim()

        return text.length > 0 ? text.slice(0, PERSONA_MAX_LENGTH) : content.slice(0, PERSONA_MAX_LENGTH)
      } finally {
        await this.input.client.session.delete({
          query: { directory: this.input.directory },
          path: { id: sessionId },
        })
        this.state.internalSessionIds.delete(sessionId)
      }
    } catch {
      return content.slice(0, PERSONA_MAX_LENGTH)
    }
  }
}
