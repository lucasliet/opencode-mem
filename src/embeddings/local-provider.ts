import { join } from "node:path"
import type { pipeline } from "@huggingface/transformers"
import type { EmbeddingProvider } from "../types"
import { getOpenCodeConfigDirectory } from "../utils"

type FeatureExtractor = Awaited<ReturnType<typeof pipeline<"feature-extraction">>>

/**
 * Generates local embeddings with a lazily loaded Transformers.js pipeline.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  private extractorPromise: Promise<FeatureExtractor> | null = null

  constructor(
    private readonly model: string,
    private readonly dimensions: number,
  ) {}

  /**
   * Returns the configured embedding model identifier.
   *
   * @returns Embedding model name.
   */
  getModel(): string {
    return this.model
  }

  /**
   * Returns the configured embedding dimension count.
   *
   * @returns Embedding vector length.
   */
  getDimensions(): number {
    return this.dimensions
  }

  /**
   * Embeds a text value using a local feature extraction pipeline.
   *
   * @param value - Text to embed.
   * @returns Normalized embedding vector.
   */
  async embed(value: string): Promise<number[]> {
    const extractor = await this.getExtractor()
    const output = await extractor(value, {
      pooling: "mean",
      normalize: true,
    })
    const rows = output.tolist() as number[] | number[][]
    const vector = Array.isArray(rows[0]) ? rows[0] : rows
    if (!Array.isArray(vector) || !vector.length) {
      throw new Error("Embedding provider returned an empty vector")
    }

    if (vector.length !== this.dimensions) {
      throw new Error(`Embedding dimension mismatch: expected ${this.dimensions}, got ${vector.length}`)
    }

    return vector.map((entry) => Number(entry))
  }

  /**
   * Lazily initializes the local feature extraction pipeline.
   *
   * @returns Cached feature extraction pipeline.
   */
  private async getExtractor(): Promise<FeatureExtractor> {
    if (!this.extractorPromise) {
      this.extractorPromise = this.createExtractor()
    }

    return this.extractorPromise
  }

  /**
   * Creates a feature extraction pipeline configured for local cache reuse.
   *
   * @returns Initialized pipeline.
   */
  private async createExtractor(): Promise<FeatureExtractor> {
    const { env, pipeline: transformersPipeline } = await import("@huggingface/transformers")
    env.allowLocalModels = true
    env.cacheDir = join(getOpenCodeConfigDirectory(), "memory", "models")

    return transformersPipeline("feature-extraction", this.model, {
      dtype: "fp32",
    }) as Promise<FeatureExtractor>
  }
}
