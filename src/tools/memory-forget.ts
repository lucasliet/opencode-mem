import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { MemoryStore } from "../storage/store"
import { formatRelativeTime } from "../utils"

const DELETE_PREVIEW_LIMIT = 50
const DELETE_MATCH_LIMIT = 5_000
const CONFIRMATION_MIN_DELAY_MS = 1_000
const CONFIRMATION_TTL_MS = 10 * 60_000

interface DeletionCriteria {
  ids?: string[]
  query?: string
  sessionId?: string
  before?: string
}

interface PendingDeletionConfirmation {
  token: string
  previewMessageId: string
  createdAt: number
  criteriaKey: string
  matchIds: string[]
}

/**
 * Creates the memory deletion tool with preview and confirm flow.
 *
 * @param store - Memory store.
 * @param now - Clock function.
 * @returns Tool definition.
 */
export function createMemoryForgetTool(store: MemoryStore, now: () => number): ToolDefinition {
  const pendingConfirmations = new Map<string, PendingDeletionConfirmation>()

  return tool({
    description:
      "Delete persistent memory observations by IDs, query, session, or date. Always run preview first. Deletion requires confirm=true with confirmationToken from preview in a later user turn.",
    args: {
      ids: tool.schema.array(tool.schema.string()).max(50).optional(),
      query: tool.schema.string().min(1).optional(),
      sessionId: tool.schema.string().min(1).optional(),
      before: tool.schema.string().datetime().optional(),
      confirm: tool.schema.boolean().optional(),
      confirmationToken: tool.schema.string().min(1).optional(),
    },
    async execute(args, context) {
      purgeExpiredConfirmations(pendingConfirmations, now())

      await store.incrementToolUsage(context.sessionID, "memory_forget")

      if (args.confirm) {
        return executeConfirmedDeletion(
          {
            confirmationToken: args.confirmationToken,
            criteria: {
              ids: args.ids,
              query: args.query,
              sessionId: args.sessionId,
              before: args.before,
            },
          },
          {
            context,
            store,
            now,
            pendingConfirmations,
          },
        )
      }

      const criteria = normalizeCriteria({
        ids: args.ids,
        query: args.query,
        sessionId: args.sessionId,
        before: args.before,
      })

      if (!hasCriteria(criteria)) {
        return "memory_forget requires at least one of: ids, query, sessionId, or before."
      }

      const preview = await buildPreview(store, criteria)

      if (!preview.matches.length) {
        return "No observations match the provided deletion criteria."
      }

      const token = createConfirmationToken()
      const key = createConfirmationKey(context.sessionID, token)
      const criteriaKey = serializeCriteria(criteria)
      pendingConfirmations.set(key, {
        token,
        previewMessageId: context.messageID,
        createdAt: now(),
        criteriaKey,
        matchIds: preview.matches.map((match) => match.id),
      })

      const lines = preview.matches
        .slice(0, DELETE_PREVIEW_LIMIT)
        .map(
          (observation) =>
            `[${observation.id}] ${observation.title} (${observation.type}, ${formatRelativeTime(observation.createdAt, now)})`,
        )

      const extra = preview.matches.length > DELETE_PREVIEW_LIMIT
        ? `\n... and ${preview.matches.length - DELETE_PREVIEW_LIMIT} more.`
        : ""

      return [
        `Will delete ${preview.matches.length} observations:`,
        ...lines,
        extra,
        "",
        `Confirmation token: ${token}`,
        "Deletion is blocked in the same assistant turn.",
        "Ask the user explicitly and only proceed after they confirm.",
        "Run memory_forget again with confirm=true and confirmationToken in a later turn.",
      ]
        .filter(Boolean)
        .join("\n")
    },
  })
}

/**
 * Executes a confirmed deletion using a pending confirmation token.
 *
 * @param args - Confirmation arguments.
 * @param dependencies - Runtime dependencies.
 * @returns Tool response.
 */
async function executeConfirmedDeletion(
  args: {
    confirmationToken?: string
    criteria: DeletionCriteria
  },
  dependencies: {
    context: {
      sessionID: string
      messageID: string
    }
    store: MemoryStore
    now: () => number
    pendingConfirmations: Map<string, PendingDeletionConfirmation>
  },
): Promise<string> {
  const { context, now, pendingConfirmations, store } = dependencies

  if (!args.confirmationToken) {
    return "memory_forget confirmation requires confirmationToken from a preview response."
  }

  const confirmationKey = createConfirmationKey(context.sessionID, args.confirmationToken)
  const pending = pendingConfirmations.get(confirmationKey)
  if (!pending) {
    return "No pending deletion confirmation found for this token. Run memory_forget preview first."
  }

  if (pending.previewMessageId === context.messageID) {
    return "Deletion blocked: confirmation must happen in a new user turn after preview."
  }

  const ageMs = now() - pending.createdAt
  if (ageMs < CONFIRMATION_MIN_DELAY_MS) {
    const remainingSeconds = Math.ceil((CONFIRMATION_MIN_DELAY_MS - ageMs) / 1000)
    return `Deletion blocked: wait ${remainingSeconds}s and ask for explicit user confirmation first.`
  }

  if (ageMs > CONFIRMATION_TTL_MS) {
    pendingConfirmations.delete(confirmationKey)
    return "Deletion confirmation token expired. Run memory_forget preview again."
  }

  const criteria = normalizeCriteria(args.criteria)
  if (hasCriteria(criteria) && serializeCriteria(criteria) !== pending.criteriaKey) {
    return "Deletion blocked: criteria do not match the preview linked to this confirmationToken."
  }

  const deletedCount = await store.deleteObservations(pending.matchIds)
  await store.logDeletion(pending.criteriaKey, deletedCount, "user")
  pendingConfirmations.delete(confirmationKey)

  return `Deleted ${deletedCount} observations from persistent memory.`
}

/**
 * Builds a stable key for a session-scoped confirmation token.
 *
 * @param sessionId - Session identifier.
 * @param token - Confirmation token.
 * @returns Internal map key.
 */
function createConfirmationKey(sessionId: string, token: string): string {
  return `${sessionId}:${token}`
}

/**
 * Creates a random confirmation token.
 *
 * @returns New token string.
 */
function createConfirmationToken(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16)
}

/**
 * Removes expired confirmation tokens from memory.
 *
 * @param confirmations - Confirmation map.
 * @param nowTimestamp - Current timestamp.
 * @returns Nothing.
 */
function purgeExpiredConfirmations(
  confirmations: Map<string, PendingDeletionConfirmation>,
  nowTimestamp: number,
): void {
  for (const [key, confirmation] of confirmations) {
    if (nowTimestamp - confirmation.createdAt > CONFIRMATION_TTL_MS) {
      confirmations.delete(key)
    }
  }
}

/**
 * Normalizes deletion criteria for deterministic comparison.
 *
 * @param criteria - Raw criteria.
 * @returns Normalized criteria.
 */
function normalizeCriteria(criteria: DeletionCriteria): DeletionCriteria {
  const ids = criteria.ids?.length
    ? [...new Set(criteria.ids.map((id) => id.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right))
    : undefined

  const query = criteria.query?.trim() || undefined
  const sessionId = criteria.sessionId?.trim() || undefined
  const before = criteria.before?.trim() || undefined

  return {
    ids: ids?.length ? ids : undefined,
    query,
    sessionId,
    before,
  }
}

/**
 * Checks whether any deletion criteria were provided.
 *
 * @param criteria - Deletion criteria.
 * @returns True when at least one criterion exists.
 */
function hasCriteria(criteria: DeletionCriteria): boolean {
  return Boolean(criteria.ids?.length || criteria.query || criteria.sessionId || criteria.before)
}

/**
 * Serializes criteria into a stable JSON string.
 *
 * @param criteria - Deletion criteria.
 * @returns Stable serialized criteria.
 */
function serializeCriteria(criteria: DeletionCriteria): string {
  return JSON.stringify(normalizeCriteria(criteria))
}

/**
 * Builds a deletion preview for the selected criteria.
 *
 * @param store - Memory store.
 * @param criteria - Deletion filters.
 * @returns Matching observations.
 */
async function buildPreview(
  store: MemoryStore,
  criteria: DeletionCriteria,
): Promise<{ matches: Awaited<ReturnType<MemoryStore["getObservationsBatch"]>> }> {
  const candidates: Awaited<ReturnType<MemoryStore["getObservationsBatch"]>> = []
  const seenIds = new Set<string>()

  if (criteria.ids?.length) {
    const rows = await store.getObservationsBatch(criteria.ids)
    addUnique(candidates, rows, seenIds)
  }

  if (criteria.query) {
    const matches = await store.searchFTS(criteria.query, DELETE_MATCH_LIMIT)
    const rows = await store.getObservationsBatch(matches.map((match) => match.id))
    addUnique(candidates, rows, seenIds)
  }

  if (criteria.sessionId) {
    const rows = await store.getSessionObservations(criteria.sessionId)
    addUnique(candidates, rows, seenIds)
  }

  if (criteria.before) {
    const beforeDate = new Date(criteria.before)
    if (!Number.isNaN(beforeDate.getTime())) {
      const rows = await store.searchByDateRange(new Date(0), beforeDate, DELETE_MATCH_LIMIT)
      addUnique(candidates, rows, seenIds)
    }
  }

  return {
    matches: candidates.sort((left, right) => right.createdAt - left.createdAt),
  }
}

/**
 * Adds observations into a list without duplicates.
 *
 * @param target - Destination array.
 * @param rows - Source observations.
 * @param seenIds - Seen IDs set.
 * @returns Nothing.
 */
function addUnique(
  target: Awaited<ReturnType<MemoryStore["getObservationsBatch"]>>,
  rows: Awaited<ReturnType<MemoryStore["getObservationsBatch"]>>,
  seenIds: Set<string>,
): void {
  for (const row of rows) {
    if (seenIds.has(row.id)) {
      continue
    }

    seenIds.add(row.id)
    target.push(row)
  }
}
