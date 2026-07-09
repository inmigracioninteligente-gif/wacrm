import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'

const NOTIFY_MODES = ['all', 'new_contact_only'] as const
type NotifyMode = (typeof NOTIFY_MODES)[number]

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/settings/notifications
 *
 * Any member may read — the settings panel needs current state to
 * render the toggle. Defaults are returned when no row exists yet
 * (account hasn't saved a config).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer')

    const { data, error } = await supabase
      .from('notification_settings')
      .select('enabled, notify_mode, admin_phone')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[settings/notifications GET] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load notification settings' },
        { status: 500 },
      )
    }

    if (!data) {
      return NextResponse.json({
        configured: false,
        enabled: false,
        notify_mode: 'new_contact_only' as NotifyMode,
        admin_phone: '',
      })
    }

    return NextResponse.json({ configured: true, ...data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/settings/notifications (admin+)
 *
 * Upsert the account's admin-notification config.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`settings-notifications:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const enabled = body.enabled === true

    const notifyMode = body.notify_mode as NotifyMode
    if (!NOTIFY_MODES.includes(notifyMode)) {
      return bad(`notify_mode must be one of: ${NOTIFY_MODES.join(', ')}`)
    }

    const rawPhone = typeof body.admin_phone === 'string' ? body.admin_phone.trim() : ''
    if (!rawPhone) return bad('admin_phone is required')
    const sanitizedPhone = sanitizePhoneForMeta(rawPhone)
    if (!isValidE164(sanitizedPhone)) {
      return bad('admin_phone must be a valid phone number (E.164, e.g. +19545405754)')
    }
    // Store with a leading + — sendTemplateMessage's caller (admin-notify)
    // re-sanitizes to digits-only at send time, same as contacts.phone.
    const adminPhone = `+${sanitizedPhone}`

    const { error: upErr } = await supabase
      .from('notification_settings')
      .upsert(
        {
          account_id: accountId,
          enabled,
          notify_mode: notifyMode,
          admin_phone: adminPhone,
        },
        { onConflict: 'account_id' },
      )

    if (upErr) {
      console.error('[settings/notifications POST] upsert error:', upErr)
      return NextResponse.json(
        { error: 'Failed to save notification settings' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
