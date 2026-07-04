import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { classifyUplRisk } from './upl-classifier'
import type { AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'anthropic',
    model: 'claude-full-model',
    apiKey: 'sk-ant-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    embeddingsApiKey: null,
    legalEscalationMessage: null,
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('classifyUplRisk', () => {
  it('classifies a clean "general_question" response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: 'general_question' }] }),
      ),
    )
    const result = await classifyUplRisk(config(), 'How much does this cost?', [])
    expect(result).toBe('general_question')
  })

  it('classifies a clean "legal_question" response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: 'legal_question' }] }),
      ),
    )
    const result = await classifyUplRisk(config(), 'Should I disclose this in my case?', [])
    expect(result).toBe('legal_question')
  })

  it('calls the provider with the cheap default model, not the account model', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: 'general_question' }] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await classifyUplRisk(config({ provider: 'anthropic', model: 'claude-full-model' }), 'hi', [])

    const [, opts] = fetchMock.mock.calls[0]
    const body = JSON.parse(opts.body as string)
    expect(body.model).not.toBe('claude-full-model')
  })

  it('fails closed to legal_question on ambiguous output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: 'not sure, could be either' }] }),
      ),
    )
    const result = await classifyUplRisk(config(), 'hi', [])
    expect(result).toBe('legal_question')
  })

  it('fails closed to legal_question on a provider error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const result = await classifyUplRisk(config(), 'hi', [])
    expect(result).toBe('legal_question')
  })

  it('fails closed to legal_question on a non-2xx provider response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      } as unknown as Response),
    )
    const result = await classifyUplRisk(config(), 'hi', [])
    expect(result).toBe('legal_question')
  })
})
