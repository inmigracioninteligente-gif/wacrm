import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentProfile } from './agent-profiles'
import {
  resolveImportTagIds,
  assignImportedContactTags,
} from '@/lib/contacts/resolve-import-tags'

interface ProfileHandoffArgs {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  /** Used as the tag's/deal's `created_by`/`user_id` — mirrors how the
   *  UPL safeguard and the auto-reply bot reuse it as the "sender of
   *  record" for system-authored writes. */
  configOwnerUserId: string
  profile: AgentProfile
}

/**
 * Fires once per conversation when the model signals (`[[HANDOFF_READY]]`,
 * parsed into `GenerateResult.handoffReady`) that the reply it just wrote
 * is the active profile's own closing/hand-off message — its objective
 * with this contact was reached. Reflects that in the CRM instead of the
 * AI quietly going quiet with no trace:
 *   - tags the contact (`profile.handoff_tag`, if set)
 *   - moves/creates the contact's deal into a named Pipeline stage
 *     (`profile.handoff_pipeline_stage`, if set)
 *   - disables auto-reply on this conversation (same switch the UPL
 *     safeguard / human-handoff check use)
 *   - logs an automated `contact_notes` entry so it's auditable from the
 *     existing contact detail view
 *
 * One-shot: claims `conversations.handoff_completed` atomically
 * (`UPDATE ... WHERE handoff_completed = false`, same optimistic pattern
 * as `claim_ai_reply_slot`) so a race between two inbound messages can't
 * double-apply the tag/stage/note. Never throws — each sub-step is
 * best-effort and independently logged, mirroring the UPL safeguard's
 * contract, so a failure in one (e.g. an unfindable pipeline stage) never
 * blocks the others.
 */
export async function applyProfileHandoff(args: ProfileHandoffArgs): Promise<void> {
  const { db, accountId, conversationId, contactId, configOwnerUserId, profile } = args

  try {
    const { data: claimed } = await db
      .from('conversations')
      .update({ handoff_completed: true, ai_autoreply_disabled: true })
      .eq('id', conversationId)
      .eq('handoff_completed', false)
      .select('id')
      .maybeSingle()
    if (!claimed) return // already handled by a concurrent inbound

    const applied: string[] = []

    if (profile.handoff_tag) {
      try {
        const { tagIdByKey } = await resolveImportTagIds(db, {
          accountId,
          userId: configOwnerUserId,
          tagNames: [profile.handoff_tag],
          canCreateTags: true,
        })
        await assignImportedContactTags(
          db,
          [{ contactId, tagNames: [profile.handoff_tag] }],
          tagIdByKey,
        )
        applied.push(`etiqueta "${profile.handoff_tag}" agregada`)
      } catch (err) {
        console.error('[profile handoff] failed to tag contact:', err)
      }
    }

    if (profile.handoff_pipeline_stage) {
      try {
        const moved = await moveContactToStageByName(db, {
          accountId,
          contactId,
          conversationId,
          configOwnerUserId,
          stageName: profile.handoff_pipeline_stage,
        })
        if (moved) applied.push(`movido a la etapa "${profile.handoff_pipeline_stage}"`)
      } catch (err) {
        console.error('[profile handoff] failed to move pipeline stage:', err)
      }
    }

    try {
      await db.from('contact_notes').insert({
        contact_id: contactId,
        user_id: configOwnerUserId,
        note_text:
          `🤖 El perfil "${profile.name}" completó su objetivo con este contacto` +
          (applied.length > 0 ? ` — ${applied.join(', ')}` : '') +
          '. La IA se desactivó en esta conversación.',
      })
    } catch (err) {
      console.error('[profile handoff] failed to log note:', err)
    }
  } catch (err) {
    console.error('[profile handoff] dispatch failed:', err)
  }
}

/**
 * Find a pipeline stage by name (case-insensitive) among the account's
 * pipelines, then move the contact's most recent open deal into it —
 * or create one if it has none. Returns false (logged) when no stage
 * with that name exists, e.g. it was renamed/deleted after the profile
 * was configured; that's a soft no-op, not a hard failure.
 */
async function moveContactToStageByName(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    conversationId: string
    configOwnerUserId: string
    stageName: string
  },
): Promise<boolean> {
  const { accountId, contactId, conversationId, configOwnerUserId, stageName } = args

  const { data: pipelines } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
  const pipelineIds = (pipelines ?? []).map((p: { id: string }) => p.id)
  if (pipelineIds.length === 0) return false

  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id, pipeline_id')
    .in('pipeline_id', pipelineIds)
    .ilike('name', stageName)
    .limit(1)
    .maybeSingle()
  if (!stage) {
    console.error(
      `[profile handoff] no pipeline stage named "${stageName}" found for account ${accountId}`,
    )
    return false
  }

  const { data: existingDeal } = await db
    .from('deals')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingDeal) {
    await db
      .from('deals')
      .update({
        stage_id: stage.id,
        pipeline_id: stage.pipeline_id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingDeal.id)
    return true
  }

  const { data: acct } = await db
    .from('accounts')
    .select('default_currency')
    .eq('id', accountId)
    .maybeSingle()

  await db.from('deals').insert({
    account_id: accountId,
    user_id: configOwnerUserId,
    pipeline_id: stage.pipeline_id,
    stage_id: stage.id,
    contact_id: contactId,
    conversation_id: conversationId,
    title: 'Lead calificado por IA',
    value: 0,
    currency: acct?.default_currency ?? 'USD',
    status: 'open',
  })
  return true
}
