import { describe, expect, it } from 'vitest'

import {
  decideBotReply,
  HUMAN_ACTIVE_WINDOW_MS,
  parseRelayPayload,
  RelayValidationError,
} from './relay-ingest'
import { hashSecret, mapTwilioStatus, toE164, isValidAccountSid } from './twilio-api'

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

  it('hashes secrets deterministically', () => {
    expect(hashSecret('abc')).toBe(hashSecret('abc'))
    expect(hashSecret('abc')).not.toBe(hashSecret('abd'))
  })
})
