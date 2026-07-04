import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { classifyUplRisk } from './upl-classifier'
import { DEFAULT_LEGAL_ESCALATION_MESSAGE, UPL_TAG_NAME } from './defaults'
import { engineSendText } from '@/lib/flows/meta-send'
import {
  resolveImportTagIds,
  assignImportedContactTags,
} from '@/lib/contacts/resolve-import-tags'

interface UplSafeguardArgs {
  accountId: string
  conversationId: string
  contactId: string
  /** Used as the tag's `created_by`/`user_id` if `requiere_revision_legal`
   *  doesn't exist yet for this account — mirrors how the auto-reply bot
   *  reuses it as the "sender of record". */
  configOwnerUserId: string
  /** The just-inserted inbound message — flagged for audit once classified. */
  messageId: string
  /** The inbound message text, used only as a fallback when the
   *  conversation has no text history yet. */
  text: string
}

/**
 * UPL (Unauthorized Practice of Law) safeguard for the AI reply assistant.
 *
 * Runs on every inbound text message — independent of `ai_configs.is_active`
 * / `auto_reply_enabled` — as long as the account has an AI provider key
 * configured (that key is what pays for the classification call). If the
 * message looks like a request for case-specific legal advice, this stands
 * in for the bot entirely: it sends a prudent hand-off reply, disables
 * further auto-replies on the thread, tags the contact, and notifies the
 * account's admins/owners — the bot never gets a chance to draft a normal
 * reply to a legal question.
 *
 * Never throws — mirrors `dispatchInboundToAiReply`'s contract so a slow or
 * failing classification can't affect the webhook's response to Meta.
 */
export async function runUplSafeguard(args: UplSafeguardArgs): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId, messageId, text } = args

  try {
    const db = supabaseAdmin()

    // requireActive:false — this safeguard must run even when the master
    // switch or auto-reply toggle are off; only a missing/undecryptable key
    // means there's truly nothing to classify with.
    const config = await loadAiConfig(db, accountId, { requireActive: false })
    if (!config) return

    const context = await buildConversationContext(db, conversationId)
    const classification = await classifyUplRisk(config, text, context)

    await db
      .from('messages')
      .update({ flagged_legal_question: classification === 'legal_question' })
      .eq('id', messageId)

    if (classification !== 'legal_question') return

    await db
      .from('conversations')
      .update({ ai_autoreply_disabled: true })
      .eq('id', conversationId)

    try {
      const { tagIdByKey } = await resolveImportTagIds(db, {
        accountId,
        userId: configOwnerUserId,
        tagNames: [UPL_TAG_NAME],
        canCreateTags: true,
      })
      await assignImportedContactTags(
        db,
        [{ contactId, tagNames: [UPL_TAG_NAME] }],
        tagIdByKey,
      )
    } catch (err) {
      console.error('[upl safeguard] failed to tag contact:', err)
    }

    try {
      await notifyAdmins(db, { accountId, conversationId, contactId })
    } catch (err) {
      console.error('[upl safeguard] failed to notify admins:', err)
    }

    try {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text: config.legalEscalationMessage?.trim() || DEFAULT_LEGAL_ESCALATION_MESSAGE,
      })
    } catch (err) {
      console.error('[upl safeguard] failed to send hand-off reply:', err)
    }
  } catch (err) {
    console.error('[upl safeguard] dispatch failed:', err)
  }
}

async function notifyAdmins(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; contactId: string },
): Promise<void> {
  const { accountId, conversationId, contactId } = args

  const [{ data: recipients }, { data: contact }] = await Promise.all([
    db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .in('account_role', ['owner', 'admin']),
    db.from('contacts').select('name, phone').eq('id', contactId).maybeSingle(),
  ])

  if (!recipients || recipients.length === 0) return

  const contactName = contact?.name?.trim() || contact?.phone || 'un contacto'

  await db.from('notifications').insert(
    recipients.map((r: { user_id: string }) => ({
      account_id: accountId,
      user_id: r.user_id,
      type: 'legal_escalation',
      conversation_id: conversationId,
      contact_id: contactId,
      actor_user_id: null,
      title: 'Posible pregunta legal detectada',
      body: `Un mensaje de ${contactName} fue clasificado como posible pregunta legal y requiere revisión.`,
    })),
  )
}
