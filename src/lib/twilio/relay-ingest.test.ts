import { describe, expect, it } from 'vitest'

import {
  decideBotReply,
  HUMAN_ACTIVE_WINDOW_MS,
  parseRelayPayload,
  RelayValidationError,
} from './relay-ingest'
import {
  hashSecret,
  isValidAccountSid,
  isValidContentSid,
  mapTwilioStatus,
  sendTwilioMessage,
  toE164,
} from './twilio-api'

const BUSINESS = '+17863860961'

describe('parseRelayPayload', () => {
  it('parses an inbound event using Twilio field names', () => {
    const evt = parseRelayPayload(
      {
        event: 'inbound',
        MessageSid: 'SM123',
        From: 'whatsapp:+13055550100',
        To: 'whatsapp:+17863860961',
        Body: 'Hola',
        ProfileName: 'Ana',
        NumMedia: '0',
      },
      BUSINESS,
    )
    expect(evt).toMatchObject({
      event: 'inbound',
      messageSid: 'SM123',
      customerPhone: '13055550100',
      body: 'Hola',
      profileName: 'Ana',
      mediaCount: 0,
    })
  })

  it('accepts a media-only inbound', () => {
    const evt = parseRelayPayload(
      { event: 'inbound', message_sid: 'SM1', from: '+13055550100', to: BUSINESS, num_media: 2 },
      BUSINESS,
    )
    expect(evt.event === 'inbound' && evt.mediaCount).toBe(2)
  })

  it('rejects an inbound addressed to another number', () => {
    expect(() =>
      parseRelayPayload(
        { event: 'inbound', message_sid: 'SM1', from: '+13055550100', to: '+19999999999', body: 'x' },
        BUSINESS,
      ),
    ).toThrow(RelayValidationError)
  })

  it('parses an outbound notice and uses "to" as the customer', () => {
    const evt = parseRelayPayload(
      {
        event: 'outbound',
        kind: 'notice',
        message_sid: 'SM9',
        from: 'whatsapp:+17863860961',
        to: 'whatsapp:+584166189181',
        body: 'Hola Carlos, revisamos tu caso',
        timestamp: '2026-10-24T12:00:00Z',
      },
      BUSINESS,
    )
    expect(evt).toMatchObject({
      event: 'outbound',
      kind: 'notice',
      customerPhone: '584166189181',
      timestamp: '2026-10-24T12:00:00.000Z',
    })
  })

  it('rejects an outbound sent from another number', () => {
    expect(() =>
      parseRelayPayload(
        { event: 'outbound', kind: 'bot_reply', message_sid: 'S', from: '+1999', to: '+1305', body: 'x' },
        BUSINESS,
      ),
    ).toThrow(/does not match/)
  })

  it('rejects unknown kinds, events and missing sids', () => {
    expect(() =>
      parseRelayPayload({ event: 'outbound', kind: 'x', message_sid: 'S', from: BUSINESS, to: '+1305', body: 'x' }, BUSINESS),
    ).toThrow(/kind/)
    expect(() => parseRelayPayload({ event: 'other', message_sid: 'S', from: 'a', to: 'b' }, BUSINESS)).toThrow(/event/)
    expect(() => parseRelayPayload({ event: 'inbound', from: 'a', to: 'b' }, BUSINESS)).toThrow(/message_sid/)
    expect(() => parseRelayPayload(null, BUSINESS)).toThrow(RelayValidationError)
  })

  it('falls back to now for an invalid timestamp', () => {
    const evt = parseRelayPayload(
      { event: 'inbound', message_sid: 'S', from: '+1305', to: BUSINESS, body: 'x', timestamp: 'nope' },
      BUSINESS,
    )
    expect(Number.isNaN(new Date(evt.timestamp).getTime())).toBe(false)
  })
})

describe('decideBotReply', () => {
  const now = Date.parse('2026-10-24T12:00:00Z')

  it('lets the bot reply when no agent has written', () => {
    expect(decideBotReply({ aiAutoreplyDisabled: false, lastAgentMessageAt: null, now })).toBeNull()
  })

  it('keeps the bot quiet within 24h of an agent reply', () => {
    const recent = new Date(now - HUMAN_ACTIVE_WINDOW_MS + 60_000).toISOString()
    expect(decideBotReply({ aiAutoreplyDisabled: false, lastAgentMessageAt: recent, now })).toBe(
      'agent_replied_recently',
    )
  })

  it('lets the bot reply again after 24h', () => {
    const old = new Date(now - HUMAN_ACTIVE_WINDOW_MS - 60_000).toISOString()
    expect(decideBotReply({ aiAutoreplyDisabled: false, lastAgentMessageAt: old, now })).toBeNull()
  })

  it('respects a manual pause regardless of timing', () => {
    expect(decideBotReply({ aiAutoreplyDisabled: true, lastAgentMessageAt: null, now })).toBe(
      'bot_paused_by_agent',
    )
  })
})

describe('twilio helpers', () => {
  it('normalises numbers to E.164', () => {
    expect(toE164('whatsapp:+1 (786) 386-0961')).toBe('+17863860961')
    expect(toE164('17863860961')).toBe('+17863860961')
    expect(toE164('')).toBe('')
  })

  it('validates account SIDs', () => {
    expect(isValidAccountSid('AC' + 'a'.repeat(32))).toBe(true)
    expect(isValidAccountSid('SK' + 'a'.repeat(32))).toBe(false)
  })

  it('maps Twilio statuses onto message statuses', () => {
    expect(mapTwilioStatus('queued')).toBe('sending')
    expect(mapTwilioStatus('delivered')).toBe('delivered')
    expect(mapTwilioStatus('undelivered')).toBe('failed')
    expect(mapTwilioStatus('weird')).toBeNull()
  })

  it('sends a Content Template with variables instead of a body', async () => {
    const calls: { url: string; body: string }[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) })
      return new Response(JSON.stringify({ sid: 'SMabc', status: 'queued' }), { status: 201 })
    }) as typeof fetch
    try {
      const res = await sendTwilioMessage({
        accountSid: 'AC' + 'a'.repeat(32),
        authToken: 't',
        from: '+17863860961',
        to: '13055550100',
        body: 'ignored',
        contentSid: 'HX' + 'b'.repeat(32),
        contentVariables: { '1': 'Ana', '2': 'Hola' },
      })
      expect(res.sid).toBe('SMabc')
      const form = new URLSearchParams(calls[0].body)
      expect(form.get('To')).toBe('whatsapp:+13055550100')
      expect(form.get('ContentSid')).toBe('HX' + 'b'.repeat(32))
      expect(JSON.parse(form.get('ContentVariables')!)).toEqual({ '1': 'Ana', '2': 'Hola' })
      expect(form.get('Body')).toBeNull()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('validates Content SIDs', () => {
    expect(isValidContentSid('HXf82889b79f3d7e86342e7c2a39bf57d8')).toBe(true)
    expect(isValidContentSid('HX123')).toBe(false)
  })

  it('hashes secrets deterministically', () => {
    expect(hashSecret('abc')).toBe(hashSecret('abc'))
    expect(hashSecret('abc')).not.toBe(hashSecret('abd'))
  })
})
