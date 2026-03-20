import type { Observation, PendingMessage, PluginConfig, SessionSummary } from "../types"
import { buildCompressionPrompt, buildSessionSummaryPrompt } from "./prompts"
import { parseObservation, parseSessionSummary } from "./parser"
import { validateObservation } from "./quality"
import { delay } from "../utils"
import { MemoryStore } from "../storage/store"
import { MemoryLogger } from "../logger"
import { selectCompressionModel } from "../config"
import type { Config, OpencodeClient } from "@opencode-ai/sdk"
import type { EmbeddingProvider, ObservationCompressor, ObservationEmbedding } from "../types"
import { buildObservationEmbeddingText } from "../embeddings/text"

/**
 * Processes queued tool outputs and turns them into persistent observations.
 */
export class CompressionPipeline {
  private activeRun: Promise<void> | null = null

  constructor(
    private readonly store: MemoryStore,
    private readonly compressor: ObservationCompressor,
    private readonly client: OpencodeClient,
    private readonly directory: string,
    private readonly pluginConfig: PluginConfig,
    private readonly embeddingProvider: EmbeddingProvider | null,
    private readonly logger: MemoryLogger,
    private readonly now: () => number,
  ) {}

  /**
   * Resets orphaned queue rows back to pending.
   *
   * @returns A promise that resolves after recovery.
   */
  async recoverOrphans(): Promise<void> {
    const orphaned = await this.store.getOrphanedMessages(this.pluginConfig.orphanThresholdMs)
    await Promise.all(
      orphaned.map((message) => this.store.updatePendingStatus(message.id, "pending", message.retryCount, message.errorMessage)),
    )
  }

  /**
   * Processes the queue until no pending messages remain.
   *
   * @returns A promise that resolves when the queue is drained.
   */
  async processQueue(): Promise<void> {
    if (this.activeRun) {
      return this.activeRun
    }

    this.activeRun = this.processLoop()
    try {
      await this.activeRun
    } finally {
      this.activeRun = null
    }
  }

  /**
   * Generates and persists a session summary when there is new activity.
   *
   * @param sessionId - OpenCode session identifier.
   * @returns The saved summary or null.
   */
  async generateSessionSummary(sessionId: string): Promise<SessionSummary | null> {
    const shouldRefresh = await this.store.hasSessionActivityAfterSummary(sessionId)
    if (!shouldRefresh) {
      return this.store.getSessionSummary(sessionId)
    }

    const observations = await this.store.getSessionObservations(sessionId)
    const prompts = await this.store.getSessionUserPrompts(sessionId)
    if (!observations.length && !prompts.length) {
      return null
    }

    const runtimeConfig = await this.loadRuntimeConfig()
    const model = selectCompressionModel(this.pluginConfig, runtimeConfig)
    const prompt = buildSessionSummaryPrompt(prompts, observations)
    const result = await this.compressor.summarizeSession({
      sessionId,
      prompt,
      model,
    })

    const summary = parseSessionSummary(result.text, {
      id: this.store.createId(),
      projectId: observations[0]?.projectId ?? prompts[0]?.projectId ?? "",
      projectRoot: observations[0]?.projectRoot ?? prompts[0]?.projectRoot ?? "",
      sessionId,
      observationCount: observations.length,
      createdAt: this.now(),
      modelUsed: result.modelUsed,
    })

    await this.store.saveSessionSummary(summary)
    await this.logger.info("Generated session summary", {
      sessionId,
      observationCount: observations.length,
    })

    return summary
  }

  /**
   * Waits until the queue is empty for a session or the timeout is reached.
   *
   * @param sessionId - OpenCode session identifier.
   * @param timeoutMs - Maximum wait duration.
   * @returns True when the queue was flushed.
   */
  async flushSession(sessionId: string, timeoutMs: number): Promise<boolean> {
    const startedAt = this.now()

    while (this.now() - startedAt < timeoutMs) {
      await this.processQueue()
      const pending = await this.store.countPendingForSession(sessionId)
      if (pending === 0) {
        return true
      }
      await delay(this.pluginConfig.queuePollIntervalMs)
    }

    return false
  }

  /**
   * Processes a single queued tool output.
   *
   * @param pendingMessage - Queue item to process.
   * @returns A promise that resolves when processing finishes.
   */
  async processSingle(pendingMessage: PendingMessage): Promise<void> {
    const runtimeConfig = await this.loadRuntimeConfig()
    const model = selectCompressionModel(this.pluginConfig, runtimeConfig)
    const startedAt = this.now()

    await this.store.updatePendingStatus(
      pendingMessage.id,
      "processing",
      pendingMessage.retryCount,
      pendingMessage.errorMessage,
    )

    try {
      const result = await this.compressor.compressObservation({
        pendingMessage,
        prompt: buildCompressionPrompt(pendingMessage),
        model,
      })

      const observation = parseObservation(result.text, pendingMessage, result.modelUsed)
      const qualityResult = validateObservation(observation, pendingMessage.rawContent)
      observation.quality = qualityResult.quality
      observation.rawFallback = qualityResult.quality === "low"
        ? pendingMessage.rawContent.slice(0, 2_000)
        : null
      await this.store.saveObservation(observation)
      await this.store.updatePendingStatus(pendingMessage.id, "processed", pendingMessage.retryCount, null)
      await this.persistObservationEmbedding(observation)

      await this.logger.info("Compressed memory observation", {
        sessionId: pendingMessage.sessionId,
        toolName: pendingMessage.toolName,
        rawTokenCount: observation.rawTokenCount,
        compressedTokenCount: observation.compressedTokenCount,
        quality: observation.quality,
        durationMs: this.now() - startedAt,
      })

      if (qualityResult.quality !== "high") {
        await this.logger.warn("Observation quality flagged", {
          sessionId: pendingMessage.sessionId,
          toolName: pendingMessage.toolName,
          quality: qualityResult.quality,
          flags: qualityResult.flags,
        })
      }
    } catch (error) {
      const retryCount = pendingMessage.retryCount + 1
      const message = error instanceof Error ? error.message : String(error)
      const status = retryCount >= this.pluginConfig.maxPendingRetries ? "failed" : "pending"
      await this.store.updatePendingStatus(pendingMessage.id, status, retryCount, message)

      if (status === "pending") {
        await delay(backoffForAttempt(retryCount))
      }

      await this.logger.warn("Failed to compress memory observation", {
        sessionId: pendingMessage.sessionId,
        toolName: pendingMessage.toolName,
        retryCount,
        error: message,
      })
    }
  }

  /**
   * Loads the current merged OpenCode config.
   *
   * @returns Runtime config.
   */
  private async loadRuntimeConfig(): Promise<Config> {
    const result = await this.client.config.get({ query: { directory: this.directory } })
    return result.data ?? {}
  }

  /**
   * Generates and stores a local embedding for a persisted observation.
   *
   * @param observation - Persisted observation.
   * @returns A promise that resolves after the embedding attempt finishes.
   */
  private async persistObservationEmbedding(observation: Observation): Promise<void> {
    if (!this.pluginConfig.enableSemanticSearch || !this.embeddingProvider) {
      return
    }

    const embeddingInput = buildObservationEmbeddingText(observation)
    if (!embeddingInput) {
      return
    }

    try {
      const vector = await this.embeddingProvider.embed(embeddingInput)
      const timestamp = this.now()
      const embedding: ObservationEmbedding = {
        observationId: observation.id,
        projectId: observation.projectId,
        embeddingModel: this.embeddingProvider.getModel(),
        embeddingDimensions: this.embeddingProvider.getDimensions(),
        embeddingInput,
        createdAt: timestamp,
        updatedAt: timestamp,
      }

      await this.store.saveObservationEmbedding(embedding, observation, vector)
    } catch (error) {
      await this.logger.warn("Failed to generate memory embedding", {
        observationId: observation.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Drains pending work in batches.
   *
   * @returns A promise that resolves when the queue is empty.
   */
  private async processLoop(): Promise<void> {
    while (true) {
      const batch = await this.store.getPendingMessages(["pending"], this.pluginConfig.compressionBatchSize)
      if (!batch.length) {
        return
      }

      await Promise.allSettled(batch.map((message) => this.processSingle(message)))
    }
  }
}

/**
 * Computes exponential backoff for queue retries.
 *
 * @param attempt - Retry attempt number.
 * @returns Delay in milliseconds.
 */
export function backoffForAttempt(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1))
}
