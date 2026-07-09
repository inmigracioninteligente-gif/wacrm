// ============================================================
// Admin WhatsApp notification — alerts the account admin's own
// phone (via the approved "paradesk_nuevo_mensaje" template) when a
// customer message comes in. Distinct from the account's business
// WhatsApp number: this always sends to `notification_settings.admin_phone`,
// never to a contact.
//
// Called fire-and-forget from the inbound webhook. Every failure
// mode here is swallowed and logged — a notification hiccup must
// never affect receiving the customer's message.
// ============================================================

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { supabaseAdmin } from '@/lib/flows/admin-client'

const TEMPLATE_NAME = 'paradesk_nuevo_mensaje'
const TEMPLATE_LANGUAGE = 'en_US'

/**
 * Meta rejects template variables containing newlines/tabs or more
 * than 4 consecutive spaces, and caps each parameter at 1024 chars.
 * Collapse whitespace and truncate so a customer's message body can
 * never break the send.
 */
function sanitizeTemplateParam(value: string, maxLength = 300): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > maxLength
    ? collapsed.slice(0, maxLength - 1) + '…'
    : collapsed
}

export interface NotifyAdminArgs {
  accountId: string
  contactName: string
  messagePreview: string
  /** Whether this is the contact's first-ever inbound message — the
   *  webhook already computes this per message before insert. */
  isFirstInboundMessage: boolean
}

/**
 * Send the admin notification template, gated by the account's
 * `notification_settings` (enabled + notify_mode). Never throws —
 * callers should still fire-and-forget with a `.catch` as
 * belt-and-braces, but every internal failure is caught and logged
 * with a `[admin-notify]` prefix here.
 */
export async function notifyAdminOfNewMessage(args: NotifyAdminArgs): Promise<void> {
  const { accountId, contactName, messagePreview, isFirstInboundMessage } = args
  try {
    const db = supabaseAdmin()

    const { data: settings, error: settingsErr } = await db
      .from('notification_settings')
      .select('enabled, notify_mode, admin_phone')
      .eq('account_id', accountId)
      .maybeSingle()

    if (settingsErr) {
      console.error('[admin-notify] settings fetch failed:', settingsErr)
      return
    }
    if (!settings || !settings.enabled) return
    if (settings.notify_mode === 'new_contact_only' && !isFirstInboundMessage) return

    const sanitizedPhone = sanitizePhoneForMeta(settings.admin_phone)
    if (!isValidE164(sanitizedPhone)) {
      console.error('[admin-notify] admin_phone is not a valid E.164 number:', settings.admin_phone)
      return
    }

    const { data: config, error: configErr } = await db
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configErr || !config) {
      console.error('[admin-notify] whatsapp_config not found for account:', accountId, configErr)
      return
    }

    const accessToken = decrypt(config.access_token)

    await sendTemplateMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: sanitizedPhone,
      templateName: TEMPLATE_NAME,
      language: TEMPLATE_LANGUAGE,
      params: [
        sanitizeTemplateParam(contactName || 'Contacto'),
        sanitizeTemplateParam(messagePreview),
      ],
    })
  } catch (err) {
    console.error('[admin-notify] failed to send admin notification:', err)
  }
}
