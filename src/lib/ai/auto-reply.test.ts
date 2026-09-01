import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  loadActiveAgentProfiles: vi.fn(),
  loadAgentProfileById: vi.fn(),
  handleMenuRouterTurn: vi.fn(),
  applyProfileHandoff: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./agent-profiles', () => ({
  loadActiveAgentProfiles: h.loadActiveAgentProfiles,
  loadAgentProfileById: h.loadAgentProfileById,
}))
vi.mock('./menu-router-dispatch', () => ({
  handleMenuRouterTurn: h.handleMenuRouterTurn,
}))
vi.mock('./profile-handoff', () => ({
  applyProfileHandoff: h.applyProfileHandoff,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
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
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, handoffReady: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  // Legacy default: no agent profiles configured for the account, so the
  // menu router is skipped entirely and `config.systemPrompt` is used
  // directly — matches pre-multi-profile behaviour for all the tests above.
  h.loadActiveAgentProfiles.mockResolvedValue([])
  h.loadAgentProfileById.mockResolvedValue(null)
  h.handleMenuRouterTurn.mockResolvedValue({ matchedProfileId: null })
  h.applyProfileHandoff.mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true })
    expect(h.state.rpcCalls).toHaveLength(0)
  })
})

describe('dispatchInboundToAiReply — multi-profile agent routing', () => {
  const PROFILES = [
    { id: 'profile-ami', name: 'AMI', menu_label: 'Certificación AMI', extra_keywords: null, position: 1, system_prompt: 'AMI PROMPT', is_active: true },
    { id: 'profile-support', name: 'Soporte', menu_label: 'Soporte', extra_keywords: null, position: 2, system_prompt: 'SUPPORT PROMPT', is_active: true },
  ]

  it('delegates to the menu router when no profile is selected yet, and skips the LLM entirely when the turn is fully handled', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      active_agent_profile_id: null,
      agent_menu_attempts: 0,
    }
    h.loadActiveAgentProfiles.mockResolvedValue(PROFILES)
    h.handleMenuRouterTurn.mockResolvedValue({ matchedProfileId: null })

    await dispatchInboundToAiReply(ARGS)

    expect(h.handleMenuRouterTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ARGS.accountId,
        conversationId: ARGS.conversationId,
        contactId: ARGS.contactId,
        configOwnerUserId: ARGS.configOwnerUserId,
        agentMenuAttempts: 0,
        activeProfiles: PROFILES,
        inboundText: 'hi',
      }),
    )
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('generates the reply with the just-matched profile system_prompt and continues to send', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      active_agent_profile_id: null,
      agent_menu_attempts: 1,
    }
    h.loadActiveAgentProfiles.mockResolvedValue(PROFILES)
    h.handleMenuRouterTurn.mockResolvedValue({ matchedProfileId: 'profile-ami' })

    await dispatchInboundToAiReply(ARGS)

    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('AMI PROMPT')
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: ARGS.conversationId, text: 'Hello!' }),
    )
  })

  it('uses the already-selected profile system_prompt instead of the account-level one', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ systemPrompt: 'ACCOUNT PROMPT' }))
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      active_agent_profile_id: 'profile-support',
      agent_menu_attempts: 0,
    }
    h.loadAgentProfileById.mockResolvedValue(PROFILES[1])

    await dispatchInboundToAiReply(ARGS)

    expect(h.loadAgentProfileById).toHaveBeenCalledWith(
      expect.anything(),
      ARGS.accountId,
      'profile-support',
    )
    expect(h.loadActiveAgentProfiles).not.toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('SUPPORT PROMPT')
    expect(systemPrompt).not.toContain('ACCOUNT PROMPT')
  })
})

describe('dispatchInboundToAiReply — profile handoff (handoff_ready)', () => {
  const PROFILE = {
    id: 'profile-ami',
    name: 'Certificación AMI',
    menu_label: 'Certificación AMI',
    extra_keywords: null,
    position: 1,
    system_prompt: 'AMI PROMPT',
    is_active: true,
    handoff_tag: 'AMI - Lead',
    handoff_pipeline_stage: 'Qualified',
  }

  it('applies the profile handoff and still sends the closing message when handoff_ready is true', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      active_agent_profile_id: 'profile-ami',
      agent_menu_attempts: 0,
      handoff_completed: false,
    }
    h.loadAgentProfileById.mockResolvedValue(PROFILE)
    h.generateReply.mockResolvedValue({
      text: 'Perfecto, alguien del equipo te contacta.',
      handoff: false,
      handoffReady: true,
    })

    await dispatchInboundToAiReply(ARGS)

    expect(h.applyProfileHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ARGS.accountId,
        conversationId: ARGS.conversationId,
        contactId: ARGS.contactId,
        configOwnerUserId: ARGS.configOwnerUserId,
        profile: PROFILE,
      }),
    )
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Perfecto, alguien del equipo te contacta.' }),
    )
  })

  it('does not re-apply the handoff when the conversation already completed it', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      active_agent_profile_id: 'profile-ami',
      agent_menu_attempts: 0,
      handoff_completed: true,
    }
    h.loadAgentProfileById.mockResolvedValue(PROFILE)
    h.generateReply.mockResolvedValue({ text: 'ok', handoff: false, handoffReady: true })

    await dispatchInboundToAiReply(ARGS)

    expect(h.applyProfileHandoff).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('does not apply a profile handoff when there is no active profile (legacy single-agent)', async () => {
    h.generateReply.mockResolvedValue({ text: 'ok', handoff: false, handoffReady: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.applyProfileHandoff).not.toHaveBeenCalled()
  })

  it('passes profileHandoff:true to buildSystemPrompt only when a profile is active', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      active_agent_profile_id: 'profile-ami',
      agent_menu_attempts: 0,
      handoff_completed: false,
    }
    h.loadAgentProfileById.mockResolvedValue(PROFILE)

    await dispatchInboundToAiReply(ARGS)

    // buildSystemPrompt itself isn't mocked, so assert indirectly via the
    // generated system prompt containing the handoff-ready instruction.
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('[[HANDOFF_READY]]')
  })
})
