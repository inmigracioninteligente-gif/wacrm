// ============================================================
// twilio_config access (service role). Callers are responsible for
// scoping: by account for sends, by secret hash / status token for
// the unauthenticated relay + status endpoints.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { hashSecret } from './twilio-api';

export interface TwilioConfigRow {
  id: string;
  account_id: string;
  user_id: string;
  account_sid: string;
  auth_token: string;
  from_number: string;
  ingest_secret_hash: string;
  status_token: string;
  public_base_url: string | null;
  /** Approved Twilio Content Template for admin alerts (migration 037). */
  notify_content_sid?: string | null;
  status: 'connected' | 'disconnected';
}

export interface ResolvedTwilioConfig {
  row: TwilioConfigRow;
  authToken: string;
}

function resolve(row: TwilioConfigRow | null): ResolvedTwilioConfig | null {
  if (!row) return null;
  return { row, authToken: decrypt(row.auth_token) };
}

/** Connected Twilio config for an account, or null. */
export async function getTwilioConfigForAccount(
  db: SupabaseClient,
  accountId: string,
): Promise<ResolvedTwilioConfig | null> {
  // Any failure here (table missing because migration 036 isn't applied,
  // undecryptable token) must not break the Meta send path — treat it
  // as "no Twilio config" and log loudly.
  try {
    const { data, error } = await db
      .from('twilio_config')
      .select('*')
      .eq('account_id', accountId)
      .eq('status', 'connected')
      .maybeSingle();
    if (error) {
      console.warn('[twilio-config] lookup failed:', error.message);
      return null;
    }
    return resolve(data as TwilioConfigRow | null);
  } catch (err) {
    console.error(
      '[twilio-config] lookup threw:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Config whose relay secret matches, or null. */
export async function getTwilioConfigBySecret(
  db: SupabaseClient,
  secret: string,
): Promise<ResolvedTwilioConfig | null> {
  if (!secret) return null;
  const { data } = await db
    .from('twilio_config')
    .select('*')
    .eq('ingest_secret_hash', hashSecret(secret))
    .eq('status', 'connected')
    .maybeSingle();
  return resolve(data as TwilioConfigRow | null);
}

export async function getTwilioConfigByStatusToken(
  db: SupabaseClient,
  token: string,
): Promise<TwilioConfigRow | null> {
  if (!token) return null;
  const { data } = await db
    .from('twilio_config')
    .select('*')
    .eq('status_token', token)
    .maybeSingle();
  return (data as TwilioConfigRow | null) ?? null;
}

export function statusCallbackUrl(row: TwilioConfigRow): string | null {
  if (!row.public_base_url) return null;
  // Twilio only calls back to public https URLs.
  if (!/^https:\/\//i.test(row.public_base_url)) return null;
  return `${row.public_base_url.replace(/\/+$/, '')}/api/channels/twilio/status?k=${encodeURIComponent(row.status_token)}`;
}
