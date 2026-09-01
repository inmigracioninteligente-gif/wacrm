import { AiError, type AiConfig, type ChatMessage, type GenerateResult } from './types'
import { HANDOFF_SENTINEL, HANDOFF_READY_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let raw: string
  switch (config.provider) {
    case 'openai':
      raw = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      raw = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(raw)
}

/**
 * Split the raw model output into `{ text, handoff, handoffReady }`. Each
 * sentinel can appear alone or trailing a partial reply; either way we
 * flag it and strip the marker from any remaining text. The two
 * sentinels are independent (different meanings — see
 * `HANDOFF_SENTINEL` / `HANDOFF_READY_SENTINEL`) and don't collide as
 * substrings of each other.
 */
export function parseGeneration(raw: string): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const handoffReady = raw.includes(HANDOFF_READY_SENTINEL)
  const text = raw
    .split(HANDOFF_SENTINEL)
    .join('')
    .split(HANDOFF_READY_SENTINEL)
    .join('')
    .trim()
  return { text, handoff, handoffReady }
}
