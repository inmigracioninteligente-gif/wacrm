import { NextResponse, after } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getTwilioConfigBySecret } from '@/lib/twilio/config'
import {
  ingestInbound,
  ingestOutbound,
  parseRelayPayload,
  RelayValidationError,
} from '@/lib/twilio/relay-ingest'
import { notifyAdminOfNewMessage } from '@/lib/whatsapp/admin-notify'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

export const maxDuration = 30

/**
 * POST /api/channels/twilio/ingest
 *
 * Relay endpoint for a Twilio WhatsApp number whose inbound webhook is
 * owned by another app (AsiloCheck). That app forwards a copy of each
 * event here. Auth: `Authorization: Bearer <relay secret>` — the
 * secret shown once in Settings → WhatsApp → Twilio. The secret also
 * selects the workspace.
 *
 * Body (JSON):
 *   { event: 'inbound', message_sid, from, to, body, profile_name?, num_media?, timestamp? }
 *   { event: 'outbound', kind: 'notice' | 'bot_reply', message_sid, from, to, body, timestamp? }
 *
 * Inbound response includes `bot_should_reply`: false when an agent
 * answered this person in the last 24h or paused the bot on the
 * conversation. The relay should skip its own auto-reply then.
 */
export async function POST(request: Request) {
  const auth = request.headers.get('authorization') ?? ''
  const secret = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice(7).trim()
    : (request.headers.get('x-paradesk-relay-secret') ?? '').trim()

  if (!secret) {
    return NextResponse.json({ error: 'Missing relay secret' }, { status: 401 })
  }

  const db = supabaseAdmin()

  let config
  try {
    config = await getTwilioConfigBySecret(db, secret)
  } catch (err) {
    console.error('[twilio-ingest] config lookup failed:', err)
    return NextResponse.json({ error: 'Configuration error' }, { status: 500 })
  }
  if (!config) {
    return NextResponse.json({ error: 'Invalid relay secret' }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  let evt
  try {
    evt = parseRelayPayload(payload, config.row.from_number)
  } catch (err) {
    if (err instanceof RelayValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
  }

  const relayCfg = {
    accountId: config.row.account_id,
    userId: config.row.user_id,
    fromNumber: config.row.from_number,
  }

  try {
    if (evt.event === 'inbound') {
      const result = await ingestInbound(db, relayCfg, evt)

      if (!result.duplicate) {
        // After the response: the relay's bot is waiting on
        // `bot_should_reply`, so notifications must not delay it.
        after(async () => {
          await notifyAdminOfNewMessage({
            accountId: relayCfg.accountId,
            contactName: result.contactName,
            messagePreview: result.previewText,
            isFirstInboundMessage: result.isFirstInboundMessage,
          }).catch((e) => console.error('[twilio-ingest] admin notify failed:', e))
          await dispatchWebhookEvent(db, relayCfg.accountId, 'message.received', {
            conversation_id: result.conversationId,
            contact_id: result.contactId,
            whatsapp_message_id: evt.messageSid,
            content_type: 'text',
            text: result.previewText,
          })
        })
      }

      return NextResponse.json({
        ok: true,
        duplicate: result.duplicate,
        conversation_id: result.conversationId,
        bot_should_reply: result.botShouldReply,
        bot_paused_reason: result.botPausedReason,
      })
    }

    const result = await ingestOutbound(db, relayCfg, evt)
    return NextResponse.json({
      ok: true,
      stored: result.stored,
      conversation_id: result.conversationId,
    })
  } catch (err) {
    console.error('[twilio-ingest] failed:', err)
    return NextResponse.json({ error: 'Failed to ingest event' }, { status: 500 })
  }
}
