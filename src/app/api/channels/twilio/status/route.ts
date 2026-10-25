import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getTwilioConfigByStatusToken } from '@/lib/twilio/config'
import { mapTwilioStatus } from '@/lib/twilio/twilio-api'

// Delivery status order — never move a message backwards (Twilio can
// deliver callbacks out of order).
const LADDER = ['sending', 'sent', 'delivered', 'read'] as const

function canTransition(current: string, next: string): boolean {
  if (next === 'failed') return current === 'sending' || current === 'sent'
  if (current === 'failed') return false
  const ci = (LADDER as readonly string[]).indexOf(current)
  const ni = (LADDER as readonly string[]).indexOf(next)
  if (ni < 0) return false
  return ci < 0 || ni > ci
}

/**
 * POST /api/channels/twilio/status?k=<status token>
 *
 * Twilio StatusCallback for messages agents send from the inbox. The
 * `k` token (per workspace, set when the message was sent) identifies
 * the account; only messages in that account's conversations change.
 */
export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get('k') ?? ''
  const db = supabaseAdmin()

  const config = await getTwilioConfigByStatusToken(db, token)
  if (!config) {
    return NextResponse.json({ error: 'Unknown token' }, { status: 401 })
  }

  let form: URLSearchParams
  try {
    form = new URLSearchParams(await request.text())
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const sid = form.get('MessageSid') ?? ''
  const status = mapTwilioStatus(form.get('MessageStatus') ?? '')
  if (!sid || !status) {
    // Acknowledge statuses we don't track so Twilio doesn't retry.
    return new NextResponse(null, { status: 204 })
  }

  const { data: rows } = await db
    .from('messages')
    .select('id, status, conversations!inner(account_id)')
    .eq('message_id', sid)
    .eq('conversations.account_id', config.account_id)

  for (const row of (rows ?? []) as { id: string; status: string }[]) {
    if (!canTransition(row.status, status)) continue
    const { error } = await db.from('messages').update({ status }).eq('id', row.id)
    if (error) console.error('[twilio-status] update failed:', error.message)
  }

  return new NextResponse(null, { status: 204 })
}
