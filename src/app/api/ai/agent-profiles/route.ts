import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const PROFILE_COLUMNS =
  'id, name, menu_label, extra_keywords, position, system_prompt, is_active, handoff_tag, handoff_pipeline_stage, created_at, updated_at'

/**
 * GET /api/ai/agent-profiles
 *
 * List the account's agent profiles (any member), ordered the same way
 * the menu router numbers them. Powers both the Setup "Perfiles" list
 * and the Playground's profile picker.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('ai_agent_profiles')
      .select(PROFILE_COLUMNS)
      .eq('account_id', accountId)
      .order('position', { ascending: true })
    if (error) {
      console.error('[ai/agent-profiles GET] error:', error)
      return NextResponse.json(
        { error: 'Failed to load agent profiles' },
        { status: 500 },
      )
    }
    return NextResponse.json({ profiles: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/agent-profiles  (admin+)
 *
 * Create a profile, appended after the current highest `position` so new
 * profiles land at the end of the menu by default.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-agent-profiles:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const menuLabel = typeof body.menu_label === 'string' ? body.menu_label.trim() : ''
    const systemPrompt =
      typeof body.system_prompt === 'string' ? body.system_prompt.trim() : ''
    const extraKeywords =
      typeof body.extra_keywords === 'string' && body.extra_keywords.trim()
        ? body.extra_keywords.trim()
        : null
    const handoffTag =
      typeof body.handoff_tag === 'string' && body.handoff_tag.trim()
        ? body.handoff_tag.trim()
        : null
    const handoffPipelineStage =
      typeof body.handoff_pipeline_stage === 'string' && body.handoff_pipeline_stage.trim()
        ? body.handoff_pipeline_stage.trim()
        : null
    const isActive = body.is_active !== false

    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
    if (!menuLabel) {
      return NextResponse.json({ error: 'menu_label is required' }, { status: 400 })
    }
    if (!systemPrompt) {
      return NextResponse.json({ error: 'system_prompt is required' }, { status: 400 })
    }

    const { data: last } = await supabase
      .from('ai_agent_profiles')
      .select('position')
      .eq('account_id', accountId)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle()
    const position = (last?.position ?? 0) + 1

    const { data: created, error } = await supabase
      .from('ai_agent_profiles')
      .insert({
        account_id: accountId,
        created_by: userId,
        name,
        menu_label: menuLabel,
        extra_keywords: extraKeywords,
        handoff_tag: handoffTag,
        handoff_pipeline_stage: handoffPipelineStage,
        system_prompt: systemPrompt,
        is_active: isActive,
        position,
      })
      .select(PROFILE_COLUMNS)
      .single()
    if (error || !created) {
      console.error('[ai/agent-profiles POST] insert error:', error)
      return NextResponse.json(
        { error: 'Failed to create agent profile' },
        { status: 500 },
      )
    }

    return NextResponse.json({ profile: created })
  } catch (err) {
    return toErrorResponse(err)
  }
}
