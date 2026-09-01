import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { latestUserMessage } from './query'
import { loadActiveAgentProfiles, loadAgentProfileById, type AgentProfile } from './agent-profiles'
import { handleMenuRouterTurn } from './menu-router-dispatch'
import { applyProfileHandoff } from './profile-handoff'
import { engineSendText } from '@/lib/flows/meta-send'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * Multi-profile routing: when the account has active `ai_agent_profiles`
 * and the conversation hasn't picked one yet, this delegates the entire
 * turn to the menu router (`menu-router-dispatch.ts`) instead of calling
 * the LLM — see the inline comment below. Once a profile is picked (or
 * the account has none configured, preserving the legacy single-agent
 * behaviour), generation proceeds as before using that profile's
 * `system_prompt` in place of the account-level `config.systemPrompt`.
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select(
        'assigned_agent_id, ai_autoreply_disabled, ai_reply_count, active_agent_profile_id, agent_menu_attempts, handoff_completed',
      )
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Multi-profile menu router: a conversation with no
    // `active_agent_profile_id` yet is routed here instead of the LLM —
    // see menu-router-dispatch.ts. Accounts with no active profiles skip
    // this entirely and keep the legacy single-agent behaviour
    // (`config.systemPrompt` used directly, below).
    let activeProfile: AgentProfile | null = null
    if (!conv.active_agent_profile_id) {
      const activeProfiles = await loadActiveAgentProfiles(db, accountId)
      if (activeProfiles.length > 0) {
        const { matchedProfileId } = await handleMenuRouterTurn({
          db,
          accountId,
          conversationId,
          contactId,
          configOwnerUserId,
          agentMenuAttempts: conv.agent_menu_attempts,
          activeProfiles,
          inboundText: latestUserMessage(messages),
        })
        // Menu sent/resent, or the router gave up — either way this turn
        // is fully handled without calling the LLM.
        if (!matchedProfileId) return
        activeProfile = activeProfiles.find((p) => p.id === matchedProfileId) ?? null
      }
    } else {
      activeProfile = await loadAgentProfileById(db, accountId, conv.active_agent_profile_id)
    }

    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: activeProfile?.system_prompt ?? config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      profileHandoff: activeProfile !== null,
    })

    const { text, handoff, handoffReady } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and leave the inbound unanswered so it surfaces in
      // the inbox for a human. Sticky until an admin re-enables.
      await db
        .from('conversations')
        .update({ ai_autoreply_disabled: true })
        .eq('id', conversationId)
      return
    }

    // The active profile's own closing message — its objective with this
    // contact was reached. Reflect that in the CRM (tag / pipeline stage /
    // note) and turn the AI off for this thread, but still send the
    // closing text below like any other reply.
    if (handoffReady && activeProfile && !conv.handoff_completed) {
      await applyProfileHandoff({
        db,
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        profile: activeProfile,
      })
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr || claimed !== true) return

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
