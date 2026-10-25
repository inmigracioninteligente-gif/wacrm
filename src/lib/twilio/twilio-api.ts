// ============================================================
// Minimal Twilio REST client for WhatsApp sends.
//
// Only what the inbox needs: send a free-form message (text and/or
// one media URL) from the workspace's Twilio WhatsApp number. Uses
// fetch + Basic auth, so no SDK dependency.
// ============================================================

import crypto from 'crypto';

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

export interface SendTwilioMessageParams extends TwilioCredentials {
  /** Business number, E.164 with '+'. */
  from: string;
  /** Recipient, E.164 with '+' (or digits — normalised here). */
  to: string;
  body?: string | null;
  mediaUrl?: string | null;
  /** Optional delivery-receipt webhook. */
  statusCallback?: string | null;
  /** Approved Content Template (HX…) — required outside the 24h window. */
  contentSid?: string | null;
  /** Template variables, e.g. { "1": "Ana", "2": "Hola" }. */
  contentVariables?: Record<string, string> | null;
}

export function isValidContentSid(sid: string): boolean {
  return /^HX[0-9a-fA-F]{32}$/.test(sid.trim());
}

export class TwilioApiError extends Error {
  readonly code: number | null;
  readonly httpStatus: number;
  constructor(message: string, code: number | null, httpStatus: number) {
    super(message);
    this.name = 'TwilioApiError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Twilio error 63016: free-form message outside the 24h window. */
export const TWILIO_OUTSIDE_WINDOW_CODE = 63016;

/** "+1 (786) 386-0961" / "whatsapp:+17863860961" / "17863860961" → "+17863860961". */
export function toE164(phone: string): string {
  const digits = (phone || '').replace(/^whatsapp:/i, '').replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

export function toWhatsAppAddress(phone: string): string {
  return `whatsapp:${toE164(phone)}`;
}

export function isValidAccountSid(sid: string): boolean {
  return /^AC[0-9a-fA-F]{32}$/.test(sid.trim());
}

export async function sendTwilioMessage(
  params: SendTwilioMessageParams,
): Promise<{ sid: string; status: string }> {
  const {
    accountSid,
    authToken,
    from,
    to,
    body,
    mediaUrl,
    statusCallback,
    contentSid,
    contentVariables,
  } = params;

  if (!body && !mediaUrl && !contentSid) {
    throw new TwilioApiError('Message needs a body, a media URL or a template', null, 400);
  }

  const form = new URLSearchParams();
  form.set('From', toWhatsAppAddress(from));
  form.set('To', toWhatsAppAddress(to));
  if (contentSid) {
    form.set('ContentSid', contentSid);
    if (contentVariables) form.set('ContentVariables', JSON.stringify(contentVariables));
  } else {
    if (body) form.set('Body', body);
    if (mediaUrl) form.set('MediaUrl', mediaUrl);
  }
  if (statusCallback) form.set('StatusCallback', statusCallback);

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new TwilioApiError(
      data?.message || `Twilio API error (HTTP ${res.status})`,
      typeof data?.code === 'number' ? data.code : null,
      res.status,
    );
  }
  return { sid: String(data.sid), status: String(data.status ?? 'queued') };
}

/**
 * Check credentials by reading the account resource. Returns the
 * account's friendly name on success; throws TwilioApiError otherwise.
 */
export async function verifyTwilioCredentials(
  creds: TwilioCredentials,
): Promise<string> {
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}.json`,
    {
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64'),
      },
    },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new TwilioApiError(
      data?.message || `Twilio rejected the credentials (HTTP ${res.status})`,
      typeof data?.code === 'number' ? data.code : null,
      res.status,
    );
  }
  return String(data.friendly_name ?? creds.accountSid);
}

// ------------------------------------------------------------
// Relay secrets
// ------------------------------------------------------------

export function generateSecret(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Map a Twilio message status onto the messages.status CHECK values. */
export function mapTwilioStatus(
  status: string,
): 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | null {
  switch ((status || '').toLowerCase()) {
    case 'accepted':
    case 'queued':
    case 'sending':
    case 'scheduled':
      return 'sending';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
    case 'undelivered':
    case 'canceled':
      return 'failed';
    default:
      return null;
  }
}
