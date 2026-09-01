import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ id: string }> }

const PROFILE_COLUMNS =
  'id, name, menu_label, extra_keywords, position, system_prompt, is_active, handoff_tag, handoff_pipeline_stage, created_at, updated_at'

/**
 * PATCH /api/ai/agent-profiles/[id]  (admin+)
 *
 * Partial update — any subset of name/menu_label/extra_keywords/
 * system_prompt/is_active/position/handoff_tag/handoff_pipeline_stage.
 * Reordering (▲▼ in Setup) is just two of these calls, one per swapped
 * profile — no dedicated reorder route.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-agent-profiles:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const update: Record<string, unknown> = {}

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      update.name = name
    }
    if (body.menu_label !== undefined) {
      const menuLabel = typeof body.menu_label === 'string' ? body.menu_label.trim() : ''
      if (!menuLabel) {
        return NextResponse.json({ error: 'menu_label cannot be empty' }, { status: 400 })
      }
      update.menu_label = menuLabel
    }
    if (body.system_prompt !== undefined) {
      const systemPrompt =
        typeof body.system_prompt === 'string' ? body.system_prompt.trim() : ''
      if (!systemPrompt) {
        return NextResponse.json({ error: 'system_prompt cannot be empty' }, { status: 400 })
      }
      update.system_prompt = systemPrompt
    }
    if (body.extra_keywords !== undefined) {
      update.extra_keywords =
        typeof body.extra_keywords === 'string' && body.extra_keywords.trim()
          ? body.extra_keywords.trim()
          : null
    }
    if (body.handoff_tag !== undefined) {
      update.handoff_tag =
        typeof body.handoff_tag === 'string' && body.handoff_tag.trim()
          ? body.handoff_tag.trim()
          : null
    }
    if (body.handoff_pipeline_stage !== undefined) {
      update.handoff_pipeline_stage =
        typeof body.handoff_pipeline_stage === 'string' && body.handoff_pipeline_stage.trim()
          ? body.handoff_pipeline_stage.trim()
          : null
    }
    if (body.is_active !== undefined) {
      update.is_active = body.is_active === true
    }
    if (body.position !== undefined) {
      const position = Number(body.position)
      if (!Number.isFinite(position)) {
        return NextResponse.json({ error: 'position must be a number' }, { status: 400 })
      }
      update.position = position
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { data: updated, error } = await supabase
      .from('ai_agent_profiles')
      .update(update)
      .eq('account_id', accountId)
      .eq('id', id)
      .select(PROFILE_COLUMNS)
      .maybeSingle()
    if (error) {
      console.error('[ai/agent-profiles/[id] PATCH] error:', error)
      return NextResponse.json(
        { error: 'Failed to update agent profile' },
        { status: 500 },
      )
    }
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    return NextResponse.json({ profile: updated })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/agent-profiles/[id]  (admin+)
 *
 * Any conversation currently pointed at this profile falls back to
 * `active_agent_profile_id = NULL` (ON DELETE SET NULL), which re-opens
 * the menu for it on the next inbound message.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const { error } = await supabase
      .from('ai_agent_profiles')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) {
      console.error('[ai/agent-profiles/[id] DELETE] error:', error)
      return NextResponse.json(
        { error: 'Failed to delete agent profile' },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
