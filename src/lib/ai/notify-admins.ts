import type { SupabaseClient } from '@supabase/supabase-js'

interface NotifyAdminsArgs {
  accountId: string
  conversationId: string
  contactId: string
  type: 'legal_escalation' | 'human_handoff_requested' | 'agent_menu_unresolved'
  title: string
  body: string
}

/**
 * Notify every owner/admin on the account of an AI-related event that
 * needs a human's attention. Shared by the UPL safeguard, the explicit
 * human-handoff check, and the menu router's give-up path — same
 * `notifications` table + recipient query, only `type`/copy differ.
 */
export async function notifyAdminsOfAiEvent(
  db: SupabaseClient,
  args: NotifyAdminsArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, type, title, body } = args

  const { data: recipients } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .in('account_role', ['owner', 'admin'])

  if (!recipients || recipients.length === 0) return

  await db.from('notifications').insert(
    recipients.map((r: { user_id: string }) => ({
      account_id: accountId,
      user_id: r.user_id,
      type,
      conversation_id: conversationId,
      contact_id: contactId,
      actor_user_id: null,
      title,
      body,
    })),
  )
}

/** Shared helper: business-friendly contact name for notification copy. */
export async function loadContactNameForNotification(
  db: SupabaseClient,
  contactId: string,
): Promise<string> {
  const { data: contact } = await db
    .from('contacts')
    .select('name, phone')
    .eq('id', contactId)
    .maybeSingle()
  return contact?.name?.trim() || contact?.phone || 'un contacto'
}
