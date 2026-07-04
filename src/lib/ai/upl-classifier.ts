import type { AiConfig, ChatMessage } from './types'
import { AI_PROVIDER_DEFAULT_MODEL, aiRequestTimeoutMs, buildUplClassifierPrompt } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'

export type UplClassification = 'legal_question' | 'general_question'

/** Small, cheap classification call — bounds cost/latency independent of
 *  whatever `max_tokens` the account's real replies use. */
const CLASSIFIER_MAX_TOKENS = 10

/**
 * Classify the customer's latest message for UPL (Unauthorized Practice of
 * Law) risk, using the account's own BYO key but the provider's cheap
 * default model (not whatever model the account configured for full
 * replies) — this call runs on every inbound message, so it needs to stay
 * fast and cheap.
 *
 * Fails closed: any unexpected output, provider error, or timeout is
 * treated as `legal_question`. This is a compliance safeguard — a false
 * positive (an unnecessary hand-off) is far cheaper than a false negative
 * (an automated reply that reads as legal advice).
 */
export async function classifyUplRisk(
  config: AiConfig,
  latestMessage: string,
  context: ChatMessage[],
): Promise<UplClassification> {
  try {
    const providerArgs = {
      apiKey: config.apiKey,
      model: AI_PROVIDER_DEFAULT_MODEL[config.provider],
      systemPrompt: buildUplClassifierPrompt(),
      messages:
        context.length > 0
          ? context
          : [{ role: 'user' as const, content: latestMessage }],
      timeoutMs: aiRequestTimeoutMs(),
      maxTokens: CLASSIFIER_MAX_TOKENS,
    }

    const raw =
      config.provider === 'anthropic'
        ? await generateAnthropic(providerArgs)
        : await generateOpenAi(providerArgs)

    return parseClassification(raw)
  } catch (err) {
    console.error('[upl classifier] classification failed, failing closed to legal_question:', err)
    return 'legal_question'
  }
}

function parseClassification(raw: string): UplClassification {
  const normalized = raw.trim().toLowerCase()
  const hasLegal = normalized.includes('legal_question')
  const hasGeneral = normalized.includes('general_question')
  // Ambiguous or unexpected output also fails closed.
  if (hasLegal || !hasGeneral) return 'legal_question'
  return 'general_question'
}
