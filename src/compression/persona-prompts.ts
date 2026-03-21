/**
 * Prompt for extracting new persona facts from a conversation turn.
 */
export const PERSONA_EXTRACTION_PROMPT = `You are a persona extractor. Analyze the conversation turn below and extract any new facts about the user.

Extract facts about:
- Code preferences (language, style, patterns, tools)
- Communication style (language, tone, level of detail)
- Work patterns (workflow, practices, habits)
- Personal context (projects, company, interests)
- Corrections or explicit preferences ("don't do X", "I prefer Y")
- Writing patterns and general tastes
- Anything that helps personify and understand the user better

Rules:
- Return ONLY a JSON array of strings, nothing else
- Each string should be a single, concise fact
- Do NOT repeat facts already in the current persona
- Do NOT extract factual/technical data (code snippets, errors, etc.)
- Focus on PREFERENCES and PATTERNS, not implementation details
- If nothing new is found, return an empty array []
- Be conservative: only extract facts that are clearly about the user

Current persona (for deduplication):
{current_persona}

Conversation:
User: {user_message}
Assistant: {assistant_message}

Extract new facts as JSON array:`

/**
 * System prompt for persona extraction.
 */
export const PERSONA_EXTRACTOR_SYSTEM_PROMPT = `You are a persona fact extractor.
Return raw JSON only.
Do not use tools.
Do not include markdown fences.
Be concise and deterministic.`

/**
 * Maximum persona content length in characters.
 */
export const PERSONA_MAX_LENGTH = 10_000

/**
 * Maximum number of extraction attempts before summarizing.
 */
export const PERSONA_SUMMARIZE_THRESHOLD = 50
