import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { classifyOutboundUplRisk } from '@/lib/ai/upl-classifier'
import { AiError } from '@/lib/ai/types'

/**
 * POST /api/ai/classify-outbound  (agent+)
 *
 * Body: { conversation_id, text }
 * Returns: { classification: 'legal_question' | 'general_question' }
 *
 * UPL (Unauthorized Practice of Law) safeguard for HUMAN-authored outbound
 * messages — the mirror image of the inbound safeguard (`upl-safeguard.ts`),
 * which only covers the AI auto-reply bot. Called once per Send click from
 * the Inbox composer, never per keystroke.
 *
 * Runs with `requireActive: false` — same reasoning as the inbound
 * safeguard: this is a compliance check, independent of whether the
 * account has the AI auto-reply master switch on. If the account has no
 * AI config at all, there is no LLM to classify with — the composer treats
 * a `skipped: true` response as "cannot classify," and the caller is
 * expected to fail closed (show the warning) on any classify error too.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const userLimit = checkRateLimit(`ai-outbound-classify:${userId}`, RATE_LIMITS.aiOutboundClassify)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    const accountLimit = checkRateLimit(
      `ai-outbound-classify-acct:${accountId}`,
      RATE_LIMITS.aiOutboundClassifyAccount,
    )
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = await request.json().catch(() => null)
    const conversationId =
      body && typeof body.conversation_id === 'string' ? body.conversation_id : ''
    const text = body && typeof body.text === 'string' ? body.text.trim() : ''
    if (!conversationId || !text) {
      return NextResponse.json(
        { error: 'conversation_id and text are required' },
        { status: 400 },
      )
    }

    // RLS scopes the SSR client to the caller's account, so a missing row
    // means "not yours / not found" either way.
    const { data: conversation, error: convErr } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr) {
      console.error('[ai/classify-outbound] conversation lookup error:', convErr)
      return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 })
    }
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const config = await loadAiConfig(supabase, accountId, { requireActive: false }).catch((err) => {
      console.error('[ai/classify-outbound] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      // No BYO key configured — nothing to classify with. Fails open:
      // the composer sends without a warning, same as if this endpoint
      // were never called.
      return NextResponse.json({ classification: 'general_question', skipped: true })
    }
    if (!config.outboundWarningsEnabled) {
      // Account opted out (Settings → AI Agents). The composer is expected
      // to skip this call entirely when the toggle is off — this is
      // defense in depth for any other caller, not the primary gate.
      return NextResponse.json({ classification: 'general_question', skipped: true })
    }

    const classification = await classifyOutboundUplRisk(config, text)
    return NextResponse.json({ classification })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
