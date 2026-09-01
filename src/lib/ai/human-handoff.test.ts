import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectHumanHandoffRequest } from './human-handoff'
import type { AiConfig } from './types'

describe('detectHumanHandoffRequest', () => {
  it('matches explicit requests for a human', () => {
    expect(detectHumanHandoffRequest('quiero hablar con un humano')).toBe(true)
    expect(detectHumanHandoffRequest('pásame con un agente por favor')).toBe(true)
    expect(detectHumanHandoffRequest('necesito hablar con una persona')).toBe(true)
    expect(detectHumanHandoffRequest('AGENTE!!')).toBe(true)
  })

  it('is accent/case-insensitive', () => {
    expect(detectHumanHandoffRequest('quiero una PERSÓNA')).toBe(true)
    expect(detectHumanHandoffRequest('Necesito un Humano YA')).toBe(true)
  })

  it('does not false-positive on words that merely contain the trigger as a substring', () => {
    expect(detectHumanHandoffRequest('me encanta tu personalidad')).toBe(false)
    expect(detectHumanHandoffRequest('los agentes de tráfico')).toBe(true) // "agentes" IS the whole word here, expected true
  })

  it('returns false for unrelated messages', () => {
    expect(detectHumanHandoffRequest('cuanto cuesta el curso')).toBe(false)
    expect(detectHumanHandoffRequest('')).toBe(false)
  })
})

const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  engineSendText: vi.fn(),
  state: {
    conversationUpdatePayload: null as Record<string, unknown> | null,
    notificationInserts: null as Record<string, unknown>[] | null,
    profiles: [] as { user_id: string }[],
    contact: { name: 'Jane Doe', phone: '+15551234567' } as Record<string, unknown> | null,
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'conversations') {
        return {
          update: (payload: Record<string, unknown>) => {
            h.state.conversationUpdatePayload = payload
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              in: () => Promise.resolve({ data: h.state.profiles, error: null }),
            }),
          }),
        }
      }
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: h.state.contact, error: null }),
            }),
          }),
        }
      }
      if (table === 'notifications') {
        return {
          insert: (rows: Record<string, unknown>[]) => {
            h.state.notificationInserts = rows
            return Promise.resolve({ error: null })
          },
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

import { runHumanHandoffCheck } from './human-handoff'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  text: 'quiero hablar con un humano',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
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
    outboundWarningsEnabled: true,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.conversationUpdatePayload = null
  h.state.notificationInserts = null
  h.state.profiles = [{ user_id: 'admin-1' }, { user_id: 'owner-1' }]
  h.state.contact = { name: 'Jane Doe', phone: '+15551234567' }
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'wamid-1' })
})

describe('runHumanHandoffCheck', () => {
  it('does nothing and returns false when the text has no handoff request', async () => {
    const handled = await runHumanHandoffCheck({ ...ARGS, text: 'cuanto cuesta el curso' })
    expect(handled).toBe(false)
    expect(h.state.conversationUpdatePayload).toBeNull()
    expect(h.loadAiConfig).not.toHaveBeenCalled()
  })

  it('does nothing when the account has no AI config', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    const handled = await runHumanHandoffCheck(ARGS)
    expect(handled).toBe(false)
    expect(h.state.conversationUpdatePayload).toBeNull()
  })

  it('disables auto-reply, notifies admins, and confirms to the customer', async () => {
    const handled = await runHumanHandoffCheck(ARGS)

    expect(handled).toBe(true)
    expect(h.state.conversationUpdatePayload).toEqual({ ai_autoreply_disabled: true })

    expect(h.state.notificationInserts).toHaveLength(2)
    expect(h.state.notificationInserts?.[0]).toMatchObject({
      account_id: ARGS.accountId,
      user_id: 'admin-1',
      type: 'human_handoff_requested',
      conversation_id: ARGS.conversationId,
      contact_id: ARGS.contactId,
    })

    expect(h.engineSendText).toHaveBeenCalledWith({
      accountId: ARGS.accountId,
      userId: ARGS.configOwnerUserId,
      conversationId: ARGS.conversationId,
      contactId: ARGS.contactId,
      text: expect.stringContaining('equipo te va a escribir'),
    })
  })

  it('still disables + notifies even if the confirmation send fails', async () => {
    h.engineSendText.mockRejectedValue(new Error('meta down'))
    const handled = await runHumanHandoffCheck(ARGS)
    expect(handled).toBe(true)
    expect(h.state.conversationUpdatePayload).toEqual({ ai_autoreply_disabled: true })
    expect(h.state.notificationInserts).toHaveLength(2)
  })

  it('never throws even if a downstream step fails', async () => {
    h.loadAiConfig.mockRejectedValue(new Error('boom'))
    await expect(runHumanHandoffCheck(ARGS)).resolves.toBe(false)
  })
})
