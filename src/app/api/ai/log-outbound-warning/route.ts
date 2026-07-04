import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

const VALID_DECISIONS = new Set(['sent_anyway', 'edited'])

/**
 * POST /api/ai/log-outbound-warning  (agent+)
 *
 * Body: { conversation_id, text, decision: 'sent_anyway' | 'edited' }
 *
 * Audit trail for the outbound UPL safeguard (see `/api/ai/classify-
 * outbound`) — called by the Inbox composer whenever the warning modal was
 * actually shown to an agent, recording which of the two explicit choices
 * they made. Never blocks sending; this only logs for compliance reporting.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const body = await request.json().catch(() => null)
    const conversationId =
      body && typeof body.conversation_id === 'string' ? body.conversation_id : ''
    const text = body && typeof body.text === 'string' ? body.text.trim() : ''
    const decision = body && typeof body.decision === 'string' ? body.decision : ''
    if (!conversationId || !text || !VALID_DECISIONS.has(decision)) {
      return NextResponse.json(
        { error: 'conversation_id, text, and a valid decision are required' },
        { status: 400 },
      )
    }

    // RLS scopes the SSR client to the caller's account, so a missing row
    // means "not yours / not found" either way — guards against logging a
    // warning against a conversation_id from another account.
    const { data: conversation, error: convErr } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr) {
      console.error('[ai/log-outbound-warning] conversation lookup error:', convErr)
      return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 })
    }
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const { error: insertErr } = await supabase.from('upl_outbound_warnings').insert({
      account_id: accountId,
      conversation_id: conversationId,
      user_id: userId,
      message_text: text,
      decision,
    })
    if (insertErr) {
      console.error('[ai/log-outbound-warning] insert error:', insertErr)
      return NextResponse.json({ error: 'Failed to log warning' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
