import type { SupabaseClient } from '@supabase/supabase-js'
import { buildMenuMessage, matchProfile } from './menu-router'
import type { AgentProfile } from './agent-profiles'
import { notifyAdminsOfAiEvent, loadContactNameForNotification } from './notify-admins'
import { engineSendText } from '@/lib/flows/meta-send'

interface MenuRouterTurnArgs {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  /** `conversations.agent_menu_attempts` as read by the caller this turn. */
  agentMenuAttempts: number
  activeProfiles: AgentProfile[]
  inboundText: string
}

export interface MenuRouterTurnResult {
  /** Non-null when a profile was just matched this turn — the caller
   *  (`dispatchInboundToAiReply`) should fall through to normal AI
   *  generation using it. Null means this function fully handled the
   *  turn itself (menu sent, resent, or gave up) and the caller should
   *  stop without calling the LLM. */
  matchedProfileId: string | null
}

/**
 * State machine for a conversation that hasn't picked an agent profile
 * yet (`active_agent_profile_id IS NULL`). Never calls the LLM — the menu
 * and the retry are template text, and matching is done by
 * `matchProfile` (number or keyword). Mirrors the "own its try/catch,
 * never throw" contract of its sibling dispatch functions via its caller
 * (`dispatchInboundToAiReply` already wraps this call).
 *
 * Turn sequence per conversation:
 *   attempts === 0        → send the numbered menu, attempts -> 1.
 *   attempts === 1 or 2, match    → set active_agent_profile_id, attempts -> 0.
 *   attempts === 1, no match      → resend the menu once more, attempts -> 2.
 *   attempts >= 2, still no match → give up: disable auto-reply on this
 *                                   thread and notify the account's admins.
 */
export async function handleMenuRouterTurn(
  args: MenuRouterTurnArgs,
): Promise<MenuRouterTurnResult> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    agentMenuAttempts,
    activeProfiles,
    inboundText,
  } = args

  if (agentMenuAttempts === 0) {
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: buildMenuMessage(activeProfiles),
    })
    await db
      .from('conversations')
      .update({ agent_menu_attempts: 1 })
      .eq('id', conversationId)
    return { matchedProfileId: null }
  }

  const matched = matchProfile(activeProfiles, inboundText)
  if (matched) {
    await db
      .from('conversations')
      .update({ active_agent_profile_id: matched.id, agent_menu_attempts: 0 })
      .eq('id', conversationId)
    return { matchedProfileId: matched.id }
  }

  if (agentMenuAttempts === 1) {
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: buildMenuMessage(activeProfiles),
    })
    await db
      .from('conversations')
      .update({ agent_menu_attempts: 2 })
      .eq('id', conversationId)
    return { matchedProfileId: null }
  }

  // agentMenuAttempts >= 2 and still no match — give up on this thread.
  await db
    .from('conversations')
    .update({ ai_autoreply_disabled: true })
    .eq('id', conversationId)

  try {
    const contactName = await loadContactNameForNotification(db, contactId)
    await notifyAdminsOfAiEvent(db, {
      accountId,
      conversationId,
      contactId,
      type: 'agent_menu_unresolved',
      title: 'No se pudo enrutar una conversación al menú de agentes',
      body: `${contactName} no pudo elegir una opción del menú tras dos intentos — la IA se desactivó en esta conversación.`,
    })
  } catch (err) {
    console.error('[menu router] failed to notify admins:', err)
  }

  return { matchedProfileId: null }
}
