import { generateText } from "ai"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ObservationCompressor, ModelSelection, RuntimeState } from "../types"

const INTERNAL_SESSION_TITLE = "[plugin-memory] background compression"
const COMPRESSOR_SYSTEM_PROMPT = `You are a background memory compressor.
Return raw JSON only.
Do not use tools.
Do not include markdown fences.
Be concise and deterministic.`

/**
 * Uses an injected AI SDK language model for compression.
 */
export class LanguageModelObservationCompressor implements ObservationCompressor {
  constructor(private readonly model: import("ai").LanguageModel) {}

  /**
   * Compresses a pending tool output using the injected model.
   *
   * @param input - Compression input.
   * @returns Raw text from the model.
   */
  async compressObservation(input: {
    pendingMessage: import("../types").PendingMessage
    prompt: string
    model: ModelSelection | null
    abortSignal?: AbortSignal
  }) {
    const result = await generateText({
      model: this.model,
      system: COMPRESSOR_SYSTEM_PROMPT,
      prompt: input.prompt,
      temperature: 0,
      maxOutputTokens: 1_000,
      abortSignal: input.abortSignal,
    })

    return {
      text: result.text,
      modelUsed: input.model?.raw ?? null,
    }
  }

  /**
   * Summarizes a session using the injected model.
   *
   * @param input - Summary input.
   * @returns Raw text from the model.
   */
  async summarizeSession(input: {
    sessionId: string
    prompt: string
    model: ModelSelection | null
    abortSignal?: AbortSignal
  }) {
    const result = await generateText({
      model: this.model,
      system: COMPRESSOR_SYSTEM_PROMPT,
      prompt: input.prompt,
      temperature: 0,
      maxOutputTokens: 1_000,
      abortSignal: input.abortSignal,
    })

    return {
      text: result.text,
      modelUsed: input.model?.raw ?? null,
    }
  }
}

/**
 * Uses ephemeral hidden OpenCode sessions to access the currently configured provider.
 */
export class SessionPromptObservationCompressor implements ObservationCompressor {
  constructor(
    private readonly input: PluginInput,
    private readonly state: RuntimeState,
  ) {}

  /**
   * Compresses a pending tool output in an ephemeral hidden session.
   *
   * @param input - Compression input.
   * @returns Raw text from the model.
   */
  async compressObservation(input: {
    pendingMessage: import("../types").PendingMessage
    prompt: string
    model: ModelSelection | null
    abortSignal?: AbortSignal
  }) {
    return this.runPrompt(input.prompt, input.model)
  }

  /**
   * Summarizes a session in an ephemeral hidden session.
   *
   * @param input - Summary input.
   * @returns Raw text from the model.
   */
  async summarizeSession(input: {
    sessionId: string
    prompt: string
    model: ModelSelection | null
    abortSignal?: AbortSignal
  }) {
    return this.runPrompt(input.prompt, input.model)
  }

  /**
   * Creates an internal session, prompts the model, and deletes the session afterwards.
   *
   * @param prompt - Prompt text.
   * @param model - Optional model override.
   * @returns Raw text and the model identifier.
   */
  private async runPrompt(prompt: string, model: ModelSelection | null) {
    const created = await this.input.client.session.create({
      query: { directory: this.input.directory },
      body: { title: INTERNAL_SESSION_TITLE },
    })

    if (created.error || !created.data) {
      throw new Error("Failed to create internal compression session")
    }

    const sessionId = created.data.id
    this.state.internalSessionIds.add(sessionId)

    try {
      const response = await this.input.client.session.prompt({
        query: { directory: this.input.directory },
        path: { id: sessionId },
        body: {
          model: model
            ? {
                providerID: model.providerID,
                modelID: model.modelID,
              }
            : undefined,
          system: COMPRESSOR_SYSTEM_PROMPT,
          parts: [{ type: "text", text: prompt }],
        },
      })

      if (response.error || !response.data) {
        throw new Error("Failed to execute internal compression prompt")
      }

      const text = response.data.parts
        .filter((part): part is import("@opencode-ai/sdk").TextPart => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim()

      if (!text) {
        throw new Error("Compression prompt returned no text output")
      }

      return {
        text,
        modelUsed: model?.raw ?? null,
      }
    } finally {
      await this.input.client.session.delete({
        query: { directory: this.input.directory },
        path: { id: sessionId },
      })
      this.state.internalSessionIds.delete(sessionId)
    }
  }
}
