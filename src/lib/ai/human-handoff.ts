import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { normalize } from './menu-router'
import { notifyAdminsOfAiEvent, loadContactNameForNotification } from './notify-admins'
import { engineSendText } from '@/lib/flows/meta-send'

/** Whole-word triggers (normalized: lowercase, accents stripped) that mean
 *  "let me talk to a person" regardless of which agent profile — or none
 *  — the conversation is currently on. */
const HANDOFF_WORD_PATTERN = /\b(humanos?|agentes?|personas?)\b/

const HANDOFF_CONFIRMATION_MESSAGE =
  'Entendido. Un miembro de nuestro equipo te va a escribir pronto.'

/**
 * True when the inbound text explicitly asks for a human — "hablar con un
 * humano", "pásame con un agente", "quiero hablar con una persona", etc.
 * Word-boundary matched so it doesn't false-positive on words that merely
 * contain these as a substring (e.g. "personalidad").
 */
export function detectHumanHandoffRequest(text: string): boolean {
  return HANDOFF_WORD_PATTERN.test(normalize(text))
}

interface HumanHandoffArgs {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  text: string
}

/**
 * Unconditional human-handoff kill switch (requirement independent of the
 * menu router / agent profile the conversation is on). Runs on every
 * inbound plain-text message alongside the UPL safeguard — same
 * `requireActive:false` gate (an AI key must be configured for this
 * account's AI module to be in play at all; no key means there's no bot
 * to hand off from). Never throws.
 */
export async function runHumanHandoffCheck(args: HumanHandoffArgs): Promise<boolean> {
  const { accountId, conversationId, contactId, configOwnerUserId, text } = args

  try {
    if (!detectHumanHandoffRequest(text)) return false

    const db = supabaseAdmin()
    const config = await loadAiConfig(db, accountId, { requireActive: false })
    if (!config) return false

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
        type: 'human_handoff_requested',
        title: 'Un cliente pidió hablar con una persona',
        body: `${contactName} pidió hablar con un humano — la IA se desactivó en esta conversación.`,
      })
    } catch (err) {
      console.error('[human handoff] failed to notify admins:', err)
    }

    try {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text: HANDOFF_CONFIRMATION_MESSAGE,
      })
    } catch (err) {
      console.error('[human handoff] failed to send confirmation:', err)
    }

    return true
  } catch (err) {
    console.error('[human handoff] dispatch failed:', err)
    return false
  }
}
