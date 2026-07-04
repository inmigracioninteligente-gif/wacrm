import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  classifyUplRisk: vi.fn(),
  engineSendText: vi.fn(),
  resolveImportTagIds: vi.fn(),
  assignImportedContactTags: vi.fn(),
  state: {
    messageUpdatePayload: null as Record<string, unknown> | null,
    conversationUpdatePayload: null as Record<string, unknown> | null,
    notificationInserts: null as Record<string, unknown>[] | null,
    profiles: [] as { user_id: string }[],
    contact: { name: 'Jane Doe', phone: '+15551234567' } as Record<string, unknown> | null,
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./upl-classifier', () => ({ classifyUplRisk: h.classifyUplRisk }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('@/lib/contacts/resolve-import-tags', () => ({
  resolveImportTagIds: h.resolveImportTagIds,
  assignImportedContactTags: h.assignImportedContactTags,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'messages') {
        return {
          update: (payload: Record<string, unknown>) => {
            h.state.messageUpdatePayload = payload
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
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

import { runUplSafeguard } from './upl-safeguard'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  messageId: 'msg-1',
  text: 'Should I disclose this in my asylum interview?',
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
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.messageUpdatePayload = null
  h.state.conversationUpdatePayload = null
  h.state.notificationInserts = null
  h.state.profiles = [{ user_id: 'admin-1' }, { user_id: 'owner-1' }]
  h.state.contact = { name: 'Jane Doe', phone: '+15551234567' }
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: ARGS.text }])
  h.classifyUplRisk.mockResolvedValue('general_question')
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'wamid-1' })
  h.resolveImportTagIds.mockResolvedValue({
    tagIdByKey: new Map([['requiere_revision_legal', 'tag-1']]),
    skippedNames: [],
  })
  h.assignImportedContactTags.mockResolvedValue(1)
})

describe('runUplSafeguard', () => {
  it('does nothing when the account has no AI config/key', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await runUplSafeguard(ARGS)
    expect(h.classifyUplRisk).not.toHaveBeenCalled()
    expect(h.state.messageUpdatePayload).toBeNull()
  })

  it('loads config even when inactive/auto-reply disabled (requireActive: false)', async () => {
    await runUplSafeguard(ARGS)
    expect(h.loadAiConfig).toHaveBeenCalledWith(expect.anything(), ARGS.accountId, {
      requireActive: false,
    })
  })

  it('flags the message false and does nothing else for a general question', async () => {
    h.classifyUplRisk.mockResolvedValue('general_question')
    await runUplSafeguard(ARGS)

    expect(h.state.messageUpdatePayload).toEqual({ flagged_legal_question: false })
    expect(h.state.conversationUpdatePayload).toBeNull()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.notificationInserts).toBeNull()
    expect(h.resolveImportTagIds).not.toHaveBeenCalled()
  })

  it('escalates a legal question: flags, disables auto-reply, tags, notifies, and sends the hand-off reply', async () => {
    h.classifyUplRisk.mockResolvedValue('legal_question')
    await runUplSafeguard(ARGS)

    expect(h.state.messageUpdatePayload).toEqual({ flagged_legal_question: true })
    expect(h.state.conversationUpdatePayload).toEqual({ ai_autoreply_disabled: true })

    expect(h.resolveImportTagIds).toHaveBeenCalledWith(expect.anything(), {
      accountId: ARGS.accountId,
      userId: ARGS.configOwnerUserId,
      tagNames: ['requiere_revision_legal'],
      canCreateTags: true,
    })
    expect(h.assignImportedContactTags).toHaveBeenCalledWith(
      expect.anything(),
      [{ contactId: ARGS.contactId, tagNames: ['requiere_revision_legal'] }],
      expect.any(Map),
    )

    expect(h.state.notificationInserts).toHaveLength(2)
    expect(h.state.notificationInserts?.[0]).toMatchObject({
      account_id: ARGS.accountId,
      user_id: 'admin-1',
      type: 'legal_escalation',
      conversation_id: ARGS.conversationId,
      contact_id: ARGS.contactId,
    })

    expect(h.engineSendText).toHaveBeenCalledWith({
      accountId: ARGS.accountId,
      userId: ARGS.configOwnerUserId,
      conversationId: ARGS.conversationId,
      contactId: ARGS.contactId,
      text: expect.stringContaining('no podemos darte asesoría legal'),
    })
  })

  it('uses the account-customized legal_escalation_message when set', async () => {
    h.classifyUplRisk.mockResolvedValue('legal_question')
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ legalEscalationMessage: 'Custom hand-off copy for AsiloCheck.' }),
    )
    await runUplSafeguard(ARGS)

    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Custom hand-off copy for AsiloCheck.' }),
    )
  })

  it('never throws even if a downstream step fails', async () => {
    h.classifyUplRisk.mockRejectedValue(new Error('boom'))
    await expect(runUplSafeguard(ARGS)).resolves.toBeUndefined()
  })

  it('still flags + disables + notifies even if tagging fails', async () => {
    h.classifyUplRisk.mockResolvedValue('legal_question')
    h.resolveImportTagIds.mockRejectedValue(new Error('tag service down'))
    await expect(runUplSafeguard(ARGS)).resolves.toBeUndefined()

    expect(h.state.conversationUpdatePayload).toEqual({ ai_autoreply_disabled: true })
    expect(h.state.notificationInserts).toHaveLength(2)
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('still tags + notifies even if the hand-off send fails', async () => {
    h.classifyUplRisk.mockResolvedValue('legal_question')
    h.engineSendText.mockRejectedValue(new Error('meta down'))
    await expect(runUplSafeguard(ARGS)).resolves.toBeUndefined()

    expect(h.assignImportedContactTags).toHaveBeenCalled()
    expect(h.state.notificationInserts).toHaveLength(2)
  })
})
