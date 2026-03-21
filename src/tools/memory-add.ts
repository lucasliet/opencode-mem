import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { MemoryStore } from "../storage/store"
import type { EmbeddingProvider, Observation, ObservationType, ProjectScope } from "../types"
import { OBSERVATION_TYPES } from "../types"
import { estimateTokenCount } from "../utils"
import { buildObservationEmbeddingText } from "../embeddings/text"

/**
 * Creates the explicit memory write tool for deliberate knowledge persistence.
 *
 * @param store - Memory store.
 * @param scope - Project scope.
 * @param embeddingProvider - Optional local embedding provider.
 * @param now - Clock function.
 * @returns Tool definition.
 */
export function createMemoryAddTool(
  store: MemoryStore,
  scope: ProjectScope,
  embeddingProvider: EmbeddingProvider | null,
  now: () => number,
): ToolDefinition {
  return tool({
    description:
      "Explicitly save a structured observation to persistent project memory. Use this to record decisions, important findings, or context that should persist across sessions.",
    args: {
      title: tool.schema.string().min(1).max(200),
      content: tool.schema.string().min(1),
      type: tool.schema.enum(OBSERVATION_TYPES).optional(),
      subtitle: tool.schema.string().max(500).optional(),
      facts: tool.schema.array(tool.schema.string()).max(20).optional(),
      concepts: tool.schema.array(tool.schema.string()).max(20).optional(),
      files: tool.schema.array(tool.schema.string()).max(20).optional(),
    },
    async execute(args, context) {
      await store.incrementToolUsage(context.sessionID, "memory_add")

      const timestamp = now()
      const observation: Observation = {
        id: store.createId(),
        projectId: scope.projectId,
        projectRoot: scope.projectRoot,
        sessionId: context.sessionID,
        type: args.type ?? "decision",
        title: args.title,
        subtitle: args.subtitle ?? null,
        narrative: args.content,
        facts: args.facts ?? [],
        concepts: args.concepts ?? [],
        filesInvolved: args.files ?? [],
        rawTokenCount: estimateTokenCount(args.content),
        compressedTokenCount: estimateTokenCount(args.title + " " + args.content),
        toolName: "memory_add",
        modelUsed: null,
        quality: "high",
        rawFallback: null,
        createdAt: timestamp,
      }

      await store.saveObservation(observation)

      if (embeddingProvider) {
        try {
          const embeddingInput = buildObservationEmbeddingText(observation)
          const vector = await embeddingProvider.embed(embeddingInput)
          await store.saveObservationEmbedding(
            {
              observationId: observation.id,
              projectId: scope.projectId,
              embeddingModel: embeddingProvider.getModel(),
              embeddingDimensions: embeddingProvider.getDimensions(),
              embeddingInput,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            observation,
            vector,
          )
        } catch {
          // Semantic enrichment is best-effort; observation is already persisted.
        }
      }

      return `Saved to memory [${observation.id}]: ${args.title} (${observation.type})`
    },
  })
}
