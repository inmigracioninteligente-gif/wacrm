import type { AiConfig, ChatMessage } from './types'
import {
  AI_PROVIDER_DEFAULT_MODEL,
  aiRequestTimeoutMs,
  buildOutboundUplClassifierPrompt,
  buildUplClassifierPrompt,
} from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'

export type UplClassification = 'legal_question' | 'general_question'

/** Small, cheap classification call — bounds cost/latency independent of
 *  whatever `max_tokens` the account's real replies use. */
const CLASSIFIER_MAX_TOKENS = 10

/**
 * Shared low-level classification call: cheap default model, tiny
 * `max_tokens`, fail-closed on any error/ambiguous output. Both the
 * inbound (customer message) and outbound (agent draft) classifiers are
 * thin wrappers that only differ in system prompt + what's fed as the
 * conversation.
 *
 * Fails closed: any unexpected output, provider error, or timeout is
 * treated as `legal_question`. This is a compliance safeguard — a false
 * positive (an unnecessary hand-off / warning) is far cheaper than a false
 * negative (a message that reads as legal advice going out unreviewed).
 */
async function runClassifier(
  config: AiConfig,
  systemPrompt: string,
  messages: ChatMessage[],
): Promise<UplClassification> {
  try {
    const providerArgs = {
      apiKey: config.apiKey,
      model: AI_PROVIDER_DEFAULT_MODEL[config.provider],
      systemPrompt,
      messages,
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

/**
 * Classify the customer's latest message for UPL (Unauthorized Practice of
 * Law) risk, using the account's own BYO key but the provider's cheap
 * default model (not whatever model the account configured for full
 * replies) — this call runs on every inbound message, so it needs to stay
 * fast and cheap.
 */
export async function classifyUplRisk(
  config: AiConfig,
  latestMessage: string,
  context: ChatMessage[],
): Promise<UplClassification> {
  return runClassifier(
    config,
    buildUplClassifierPrompt(),
    context.length > 0 ? context : [{ role: 'user', content: latestMessage }],
  )
}

/**
 * Classify a HUMAN AGENT's outgoing draft for UPL risk — the mirror image
 * of `classifyUplRisk`. Runs once per Send click from the Inbox composer,
 * never per keystroke, so it stays cheap. Independent of the AI auto-reply
 * feature: never used on messages that already went through the bot's own
 * safeguard.
 */
export async function classifyOutboundUplRisk(
  config: AiConfig,
  draftText: string,
): Promise<UplClassification> {
  return runClassifier(config, buildOutboundUplClassifierPrompt(), [
    { role: 'user', content: draftText },
  ])
}

function parseClassification(raw: string): UplClassification {
  const normalized = raw.trim().toLowerCase()
  const hasLegal = normalized.includes('legal_question')
  const hasGeneral = normalized.includes('general_question')
  // Ambiguous or unexpected output also fails closed.
  if (hasLegal || !hasGeneral) return 'legal_question'
  return 'general_question'
}
