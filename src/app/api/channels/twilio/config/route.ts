import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import {
  generateSecret,
  hashSecret,
  isValidAccountSid,
  isValidContentSid,
  toE164,
  TwilioApiError,
  verifyTwilioCredentials,
} from '@/lib/twilio/twilio-api'

function publicBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const host =
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    request.headers.get('host')?.trim()
  const proto =
    request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
    new URL(request.url).protocol.replace(':', '')
  return host ? `${proto}://${host}` : new URL(request.url).origin
}

/**
 * GET /api/channels/twilio/config — current Twilio channel settings for
 * the caller's workspace. Never returns the auth token or the secret.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer')
    const { data, error } = await ctx.supabase
      .from('twilio_config')
      .select('*')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error) {
      return NextResponse.json(
        {
          configured: false,
          migration_missing: true,
          error: 'Twilio channel table not found — apply migration 036_twilio_channel.sql.',
        },
        { status: 200 },
      )
    }

    const base = data?.public_base_url || publicBaseUrl(request)
    return NextResponse.json({
      configured: Boolean(data),
      account_sid: data?.account_sid ?? null,
      from_number: data?.from_number ?? null,
      status: data?.status ?? null,
      updated_at: data?.updated_at ?? null,
      // Undefined until migration 037 is applied.
      notify_content_sid: data?.notify_content_sid ?? null,
      ingest_url: `${base}/api/channels/twilio/ingest`,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/channels/twilio/config
 *   { account_sid, auth_token?, from_number }   save / update
 *   { action: 'rotate_secret' }                 issue a new relay secret
 *
 * A relay secret is generated on first save and on rotation; it is
 * returned ONCE in `relay_secret` and only its hash is stored.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = await request.json().catch(() => ({}))

    const { data: existing } = await ctx.supabase
      .from('twilio_config')
      .select('id, auth_token, account_sid')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (body?.action === 'rotate_secret') {
      if (!existing) {
        return NextResponse.json({ error: 'Save the Twilio settings first.' }, { status: 400 })
      }
      const relaySecret = generateSecret('pdr')
      const { error } = await ctx.supabase
        .from('twilio_config')
        .update({ ingest_secret_hash: hashSecret(relaySecret) })
        .eq('id', existing.id)
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      return NextResponse.json({ success: true, relay_secret: relaySecret })
    }

    const accountSid = String(body?.account_sid ?? '').trim()
    const authTokenInput = String(body?.auth_token ?? '').trim()
    const fromNumber = toE164(String(body?.from_number ?? ''))

    if (!isValidAccountSid(accountSid)) {
      return NextResponse.json(
        { error: 'Account SID must start with "AC" followed by 32 characters.' },
        { status: 400 },
      )
    }
    if (!/^\+[1-9]\d{6,14}$/.test(fromNumber)) {
      return NextResponse.json(
        { error: 'Enter the WhatsApp number in international format, e.g. +17863860961.' },
        { status: 400 },
      )
    }

    // Keep the stored token when the field is left blank on an update
    // — but only if the SID didn't change (a new SID needs its token).
    let authToken = authTokenInput
    if (!authToken && existing && existing.account_sid === accountSid) {
      authToken = decrypt(existing.auth_token)
    }
    if (!authToken) {
      return NextResponse.json({ error: 'Auth Token is required.' }, { status: 400 })
    }

    try {
      await verifyTwilioCredentials({ accountSid, authToken })
    } catch (err) {
      const message = err instanceof TwilioApiError ? err.message : 'Could not reach Twilio'
      return NextResponse.json(
        { error: `Twilio rejected the credentials: ${message}` },
        { status: 400 },
      )
    }

    // Optional approved Content Template for admin alerts. Only sent
    // when the client includes the field, so a pre-037 schema without
    // the column keeps working.
    const notifyInput =
      typeof body?.notify_content_sid === 'string' ? body.notify_content_sid.trim() : undefined
    if (notifyInput && !isValidContentSid(notifyInput)) {
      return NextResponse.json(
        { error: 'The notification template SID must start with "HX" followed by 32 characters.' },
        { status: 400 },
      )
    }

    const base = publicBaseUrl(request)
    const row = {
      account_sid: accountSid,
      auth_token: encrypt(authToken),
      from_number: fromNumber,
      public_base_url: base,
      status: 'connected' as const,
      ...(notifyInput !== undefined ? { notify_content_sid: notifyInput || null } : {}),
    }

    if (existing) {
      const { error } = await ctx.supabase
        .from('twilio_config')
        .update(row)
        .eq('id', existing.id)
      if (error) {
        const dup = error.code === '23505'
        return NextResponse.json(
          { error: dup ? 'That number is already connected to another workspace.' : error.message },
          { status: dup ? 409 : 500 },
        )
      }
      return NextResponse.json({ success: true, relay_secret: null })
    }

    const relaySecret = generateSecret('pdr')
    const { error } = await ctx.supabase.from('twilio_config').insert({
      ...row,
      account_id: ctx.accountId,
      user_id: ctx.userId,
      ingest_secret_hash: hashSecret(relaySecret),
      status_token: generateSecret('pds'),
    })
    if (error) {
      const dup = error.code === '23505'
      return NextResponse.json(
        { error: dup ? 'That number is already connected to another workspace.' : error.message },
        { status: dup ? 409 : 500 },
      )
    }
    return NextResponse.json({ success: true, relay_secret: relaySecret })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/channels/twilio/config — disconnect the Twilio channel. */
export async function DELETE() {
  try {
    const ctx = await requireRole('admin')
    const { error } = await ctx.supabase
      .from('twilio_config')
      .delete()
      .eq('account_id', ctx.accountId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
