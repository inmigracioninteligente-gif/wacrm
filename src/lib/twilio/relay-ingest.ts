// ============================================================
// Twilio relay ingest — the core behind /api/channels/twilio/ingest.
//
// The external app that owns the Twilio number (AsiloCheck) relays
// three kinds of events:
//
//   • inbound            a customer wrote to the business number
//   • outbound/bot_reply the external bot answered that customer
//   • outbound/notice    an automated notice (e.g. the daily USCIS
//                        case update) went out
//
// Rules:
//   - inbound opens / reuses the contact's conversation, bumps unread,
//     and first moves any buffered notices into it as context.
//   - bot replies and notices are stored as `bot` messages without
//     touching unread_count, so they never make a thread look new.
//   - a notice for someone with NO conversation is buffered in
//     twilio_context_backlog instead of opening a conversation.
//   - the inbound response tells the relay whether its bot should
//     answer: not when an agent replied in the last 24h, nor when an
//     agent paused the bot on that conversation.
//
// Every path is idempotent on the Twilio MessageSid, so relay retries
// never duplicate messages.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

/** How long an agent reply keeps the external bot quiet. */
export const HUMAN_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Max buffered notices moved into a conversation on first contact. */
export const BACKLOG_REPLAY_LIMIT = 10;
/** Buffered notices older than this are discarded. */
export const BACKLOG_TTL_DAYS = 30;

export type RelayEvent =
  | {
      event: 'inbound';
      messageSid: string;
      /** Customer phone (any format). */
      customerPhone: string;
      body: string;
      profileName?: string | null;
      mediaCount: number;
      timestamp: string;
    }
  | {
      event: 'outbound';
      kind: 'notice' | 'bot_reply';
      messageSid: string;
      customerPhone: string;
      body: string;
      timestamp: string;
    };

export interface RelayConfig {
  accountId: string;
  /** Audit user for NOT NULL user_id on created rows. */
  userId: string;
  /** Business number, E.164. */
  fromNumber: string;
}

export interface InboundResult {
  conversationId: string;
  contactId: string;
  duplicate: boolean;
  botShouldReply: boolean;
  /** Why the bot should stay quiet, when it should. */
  botPausedReason: 'agent_replied_recently' | 'bot_paused_by_agent' | null;
  /** True when this is the contact's first message ever (for notifications). */
  isFirstInboundMessage: boolean;
  contactName: string;
  previewText: string;
}

export interface OutboundResult {
  stored: 'conversation' | 'backlog' | 'duplicate';
  conversationId: string | null;
}

export class RelayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayValidationError';
  }
}

// ------------------------------------------------------------
// Payload parsing
// ------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Validate and normalise the relay JSON body. Accepts Twilio's own
 * field names (MessageSid, From, To, Body, ProfileName, NumMedia) so
 * the relay can forward Twilio's params almost verbatim, plus the
 * lowercase aliases.
 */
export function parseRelayPayload(
  raw: unknown,
  businessNumber: string,
): RelayEvent {
  if (!raw || typeof raw !== 'object') {
    throw new RelayValidationError('Body must be a JSON object');
  }
  const b = raw as Record<string, unknown>;

  const event = str(b.event);
  const messageSid = str(b.message_sid) || str(b.MessageSid) || str(b.SmsMessageSid);
  const from = str(b.from) || str(b.From);
  const to = str(b.to) || str(b.To);
  const body = str(b.body) || str(b.Body);
  const timestampRaw = str(b.timestamp);
  const ts = timestampRaw ? new Date(timestampRaw) : new Date();
  const timestamp = Number.isNaN(ts.getTime())
    ? new Date().toISOString()
    : ts.toISOString();

  if (!messageSid) throw new RelayValidationError('message_sid is required');
  if (!from || !to) throw new RelayValidationError('from and to are required');

  const business = normalizePhone(businessNumber);
  const fromDigits = normalizePhone(from);
  const toDigits = normalizePhone(to);

  if (event === 'inbound') {
    if (toDigits !== business) {
      throw new RelayValidationError(
        'inbound "to" does not match this workspace\'s Twilio number',
      );
    }
    const mediaCount = Number(b.num_media ?? b.NumMedia ?? 0) || 0;
    if (!body.trim() && mediaCount === 0) {
      throw new RelayValidationError('inbound message has no body or media');
    }
    return {
      event: 'inbound',
      messageSid,
      customerPhone: fromDigits,
      body,
      profileName: str(b.profile_name) || str(b.ProfileName) || null,
      mediaCount,
      timestamp,
    };
  }

  if (event === 'outbound') {
    const kind = str(b.kind);
    if (kind !== 'notice' && kind !== 'bot_reply') {
      throw new RelayValidationError('outbound kind must be "notice" or "bot_reply"');
    }
    if (fromDigits !== business) {
      throw new RelayValidationError(
        'outbound "from" does not match this workspace\'s Twilio number',
      );
    }
    if (!body.trim()) throw new RelayValidationError('outbound body is required');
    return { event: 'outbound', kind, messageSid, customerPhone: toDigits, body, timestamp };
  }

  throw new RelayValidationError('event must be "inbound" or "outbound"');
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

async function findOrCreateContact(
  db: SupabaseClient,
  cfg: RelayConfig,
  phone: string,
  name: string | null,
): Promise<{ contact: { id: string; name?: string | null; phone: string }; created: boolean }> {
  const existing = await findExistingContact(db, cfg.accountId, phone);
  if (existing) {
    // Fill a missing name, but never overwrite one an agent typed.
    if (name && (!existing.name || existing.name === existing.phone)) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    }
    return { contact: existing, created: false };
  }

  const { data, error } = await db
    .from('contacts')
    .insert({
      account_id: cfg.accountId,
      user_id: cfg.userId,
      phone,
      name: name || phone,
    })
    .select('id, name, phone')
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(db, cfg.accountId, phone);
      if (raced) return { contact: raced, created: false };
    }
    throw new Error(`Failed to create contact: ${error.message}`);
  }
  return { contact: data, created: true };
}

async function findConversation(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
) {
  const { data } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle();
  return data;
}

async function findOrCreateConversation(
  db: SupabaseClient,
  cfg: RelayConfig,
  contactId: string,
) {
  const existing = await findConversation(db, cfg.accountId, contactId);
  if (existing) return { conversation: existing, created: false };

  const { data, error } = await db
    .from('conversations')
    .insert({ account_id: cfg.accountId, user_id: cfg.userId, contact_id: contactId })
    .select('*')
    .single();

  if (error || !data) {
    // A concurrent relay call may have created it first.
    const raced = await findConversation(db, cfg.accountId, contactId);
    if (raced) return { conversation: raced, created: false };
    throw new Error(`Failed to create conversation: ${error?.message}`);
  }
  return { conversation: data, created: true };
}

async function messageExists(
  db: SupabaseClient,
  conversationId: string,
  messageSid: string,
): Promise<boolean> {
  const { data } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('message_id', messageSid)
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

/** Move buffered notices for this phone into the conversation, oldest first. */
async function replayBacklog(
  db: SupabaseClient,
  accountId: string,
  phoneNormalized: string,
  conversationId: string,
): Promise<void> {
  const cutoff = new Date(Date.now() - BACKLOG_TTL_DAYS * 86400000).toISOString();

  const { data: rows } = await db
    .from('twilio_context_backlog')
    .select('id, message_sid, body, sent_at')
    .eq('account_id', accountId)
    .eq('phone_normalized', phoneNormalized)
    .gte('sent_at', cutoff)
    .order('sent_at', { ascending: false })
    .limit(BACKLOG_REPLAY_LIMIT);

  const recent = (rows ?? []) as {
    id: string;
    message_sid: string;
    body: string | null;
    sent_at: string;
  }[];

  if (recent.length > 0) {
    const toInsert = [];
    for (const row of recent.slice().reverse()) {
      if (await messageExists(db, conversationId, row.message_sid)) continue;
      toInsert.push({
        conversation_id: conversationId,
        sender_type: 'bot',
        content_type: 'text',
        content_text: row.body,
        message_id: row.message_sid,
        status: 'delivered',
        created_at: row.sent_at,
      });
    }
    if (toInsert.length > 0) {
      const { error } = await db.from('messages').insert(toInsert);
      if (error) {
        // Keep the backlog so a later inbound can retry the replay.
        console.error('[twilio-relay] backlog replay insert failed:', error.message);
        return;
      }
    }
  }

  // Clear everything buffered for this phone (including expired rows).
  await db
    .from('twilio_context_backlog')
    .delete()
    .eq('account_id', accountId)
    .eq('phone_normalized', phoneNormalized);
}

/**
 * Decide whether the external bot should answer this inbound.
 * Exported for unit tests.
 */
export function decideBotReply(input: {
  aiAutoreplyDisabled: boolean;
  lastAgentMessageAt: string | null;
  now?: number;
}): InboundResult['botPausedReason'] {
  if (input.aiAutoreplyDisabled) return 'bot_paused_by_agent';
  if (input.lastAgentMessageAt) {
    const t = new Date(input.lastAgentMessageAt).getTime();
    const now = input.now ?? Date.now();
    if (!Number.isNaN(t) && now - t < HUMAN_ACTIVE_WINDOW_MS) {
      return 'agent_replied_recently';
    }
  }
  return null;
}

async function botPausedReasonFor(
  db: SupabaseClient,
  conversation: { id: string; ai_autoreply_disabled?: boolean | null },
): Promise<InboundResult['botPausedReason']> {
  const { data } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'agent')
    .order('created_at', { ascending: false })
    .limit(1);
  const last = Array.isArray(data) && data[0] ? (data[0].created_at as string) : null;
  return decideBotReply({
    aiAutoreplyDisabled: Boolean(conversation.ai_autoreply_disabled),
    lastAgentMessageAt: last,
  });
}

// ------------------------------------------------------------
// Handlers
// ------------------------------------------------------------

export async function ingestInbound(
  db: SupabaseClient,
  cfg: RelayConfig,
  evt: Extract<RelayEvent, { event: 'inbound' }>,
): Promise<InboundResult> {
  const phone = normalizePhone(evt.customerPhone);
  const { contact } = await findOrCreateContact(db, cfg, phone, evt.profileName ?? null);
  const { conversation } = await findOrCreateConversation(db, cfg, contact.id);

  const contactName = (contact.name as string | null) || phone;
  const previewText =
    evt.body.trim() ||
    (evt.mediaCount > 0 ? '[Adjunto — ver en Twilio]' : '[mensaje]');

  if (await messageExists(db, conversation.id, evt.messageSid)) {
    const reason = await botPausedReasonFor(db, conversation);
    return {
      conversationId: conversation.id,
      contactId: contact.id,
      duplicate: true,
      botShouldReply: reason === null,
      botPausedReason: reason,
      isFirstInboundMessage: false,
      contactName,
      previewText,
    };
  }

  // Notices sent before this person ever wrote become context first,
  // so they sit above the inbound message in the thread.
  await replayBacklog(db, cfg.accountId, phone, conversation.id);

  const { count: priorCustomer } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer');

  // Twilio media URLs need account auth to open, so the inbox can't
  // render them directly. Note the attachment in the text instead.
  const contentText =
    evt.mediaCount > 0
      ? [evt.body.trim(), `📎 ${evt.mediaCount} adjunto(s) — ver en Twilio`]
          .filter(Boolean)
          .join('\n')
      : evt.body;

  const { error: insErr } = await db.from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: 'text',
    content_text: contentText,
    message_id: evt.messageSid,
    status: 'delivered',
    created_at: evt.timestamp,
  });
  if (insErr) throw new Error(`Failed to store inbound message: ${insErr.message}`);

  const now = new Date().toISOString();
  await db
    .from('conversations')
    .update({
      last_message_text: previewText,
      last_message_at: now,
      unread_count: (conversation.unread_count || 0) + 1,
      // A new message from the customer reopens a closed thread.
      ...(conversation.status === 'closed' ? { status: 'open' } : {}),
      updated_at: now,
    })
    .eq('id', conversation.id);

  const reason = await botPausedReasonFor(db, conversation);

  return {
    conversationId: conversation.id,
    contactId: contact.id,
    duplicate: false,
    botShouldReply: reason === null,
    botPausedReason: reason,
    isFirstInboundMessage: (priorCustomer ?? 0) === 0,
    contactName,
    previewText,
  };
}

export async function ingestOutbound(
  db: SupabaseClient,
  cfg: RelayConfig,
  evt: Extract<RelayEvent, { event: 'outbound' }>,
): Promise<OutboundResult> {
  const phone = normalizePhone(evt.customerPhone);
  const contact = await findExistingContact(db, cfg.accountId, phone);
  const conversation = contact
    ? await findConversation(db, cfg.accountId, contact.id)
    : null;

  if (!conversation) {
    // No thread yet — buffer as context instead of opening one.
    const { error } = await db.from('twilio_context_backlog').insert({
      account_id: cfg.accountId,
      phone_normalized: phone,
      message_sid: evt.messageSid,
      body: evt.body,
      sent_at: evt.timestamp,
    });
    if (error) {
      if (isUniqueViolation(error)) return { stored: 'duplicate', conversationId: null };
      throw new Error(`Failed to buffer notice: ${error.message}`);
    }
    return { stored: 'backlog', conversationId: null };
  }

  if (await messageExists(db, conversation.id, evt.messageSid)) {
    return { stored: 'duplicate', conversationId: conversation.id };
  }

  const { error } = await db.from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'bot',
    content_type: 'text',
    content_text: evt.body,
    message_id: evt.messageSid,
    status: 'sent',
    created_at: evt.timestamp,
  });
  if (error) throw new Error(`Failed to store outbound message: ${error.message}`);

  // A bot reply is part of the live exchange, so it updates the
  // preview and ordering. A notice is background context: it leaves
  // the thread's position and unread state alone.
  if (evt.kind === 'bot_reply') {
    await db
      .from('conversations')
      .update({
        last_message_text: evt.body,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id);
  }

  return { stored: 'conversation', conversationId: conversation.id };
}
