import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentProfile } from './agent-profiles'

const h = vi.hoisted(() => ({
  resolveImportTagIds: vi.fn(),
  assignImportedContactTags: vi.fn(),
  state: {
    conversationUpdatePayload: null as Record<string, unknown> | null,
    conversationClaimed: true as boolean,
    noteInserts: [] as Record<string, unknown>[],
    pipelines: [{ id: 'pipeline-1' }] as { id: string }[],
    stage: { id: 'stage-qualified', pipeline_id: 'pipeline-1' } as
      | { id: string; pipeline_id: string }
      | null,
    existingDeal: null as { id: string } | null,
    dealUpdatePayload: null as Record<string, unknown> | null,
    dealInsertPayload: null as Record<string, unknown> | null,
    account: { default_currency: 'USD' },
  },
}))

vi.mock('@/lib/contacts/resolve-import-tags', () => ({
  resolveImportTagIds: h.resolveImportTagIds,
  assignImportedContactTags: h.assignImportedContactTags,
}))

function makeDb() {
  return {
    from: (table: string) => {
      if (table === 'conversations') {
        return {
          update: (payload: Record<string, unknown>) => {
            h.state.conversationUpdatePayload = payload
            return {
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    maybeSingle: () =>
                      Promise.resolve({
                        data: h.state.conversationClaimed ? { id: 'conv-1' } : null,
                        error: null,
                      }),
                  }),
                }),
              }),
            }
          },
        }
      }
      if (table === 'contact_notes') {
        return {
          insert: (payload: Record<string, unknown>) => {
            h.state.noteInserts.push(payload)
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'pipelines') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: h.state.pipelines, error: null }),
          }),
        }
      }
      if (table === 'pipeline_stages') {
        return {
          select: () => ({
            in: () => ({
              ilike: () => ({
                limit: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: h.state.stage, error: null }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'deals') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: () =>
                        Promise.resolve({ data: h.state.existingDeal, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            h.state.dealUpdatePayload = payload
            return { eq: () => Promise.resolve({ error: null }) }
          },
          insert: (payload: Record<string, unknown>) => {
            h.state.dealInsertPayload = payload
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'accounts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: h.state.account, error: null }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  } as never
}

import { applyProfileHandoff } from './profile-handoff'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'profile-ami',
    name: 'Certificación AMI',
    menu_label: 'Certificación AMI',
    extra_keywords: 'curso',
    position: 1,
    system_prompt: 'prompt',
    is_active: true,
    handoff_tag: 'AMI - Lead',
    handoff_pipeline_stage: 'Qualified',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.conversationUpdatePayload = null
  h.state.conversationClaimed = true
  h.state.noteInserts = []
  h.state.pipelines = [{ id: 'pipeline-1' }]
  h.state.stage = { id: 'stage-qualified', pipeline_id: 'pipeline-1' }
  h.state.existingDeal = null
  h.state.dealUpdatePayload = null
  h.state.dealInsertPayload = null
  h.state.account = { default_currency: 'USD' }
  h.resolveImportTagIds.mockResolvedValue({
    tagIdByKey: new Map([['ami - lead', 'tag-1']]),
    skippedNames: [],
  })
  h.assignImportedContactTags.mockResolvedValue(1)
})

describe('applyProfileHandoff', () => {
  it('tags the contact, creates a deal in the named stage, disables AI, and logs a note', async () => {
    const db = makeDb()
    await applyProfileHandoff({ db, ...ARGS, profile: profile() })

    expect(h.state.conversationUpdatePayload).toEqual({
      handoff_completed: true,
      ai_autoreply_disabled: true,
    })

    expect(h.resolveImportTagIds).toHaveBeenCalledWith(db, {
      accountId: ARGS.accountId,
      userId: ARGS.configOwnerUserId,
      tagNames: ['AMI - Lead'],
      canCreateTags: true,
    })
    expect(h.assignImportedContactTags).toHaveBeenCalledWith(
      db,
      [{ contactId: ARGS.contactId, tagNames: ['AMI - Lead'] }],
      expect.any(Map),
    )

    expect(h.state.dealInsertPayload).toMatchObject({
      account_id: ARGS.accountId,
      contact_id: ARGS.contactId,
      pipeline_id: 'pipeline-1',
      stage_id: 'stage-qualified',
    })
    expect(h.state.dealUpdatePayload).toBeNull()

    expect(h.state.noteInserts).toHaveLength(1)
    expect(h.state.noteInserts[0]).toMatchObject({
      contact_id: ARGS.contactId,
      user_id: ARGS.configOwnerUserId,
    })
    expect(h.state.noteInserts[0].note_text).toContain('Certificación AMI')
    expect(h.state.noteInserts[0].note_text).toContain('AMI - Lead')
    expect(h.state.noteInserts[0].note_text).toContain('Qualified')
  })

  it('moves an existing open deal instead of creating a new one', async () => {
    h.state.existingDeal = { id: 'deal-1' }
    const db = makeDb()
    await applyProfileHandoff({ db, ...ARGS, profile: profile() })

    expect(h.state.dealUpdatePayload).toMatchObject({
      stage_id: 'stage-qualified',
      pipeline_id: 'pipeline-1',
    })
    expect(h.state.dealInsertPayload).toBeNull()
  })

  it('skips tagging and stage-moving when the profile has neither configured, but still disables AI and logs a note', async () => {
    const db = makeDb()
    await applyProfileHandoff({
      db,
      ...ARGS,
      profile: profile({ handoff_tag: null, handoff_pipeline_stage: null }),
    })

    expect(h.resolveImportTagIds).not.toHaveBeenCalled()
    expect(h.state.dealInsertPayload).toBeNull()
    expect(h.state.conversationUpdatePayload).toEqual({
      handoff_completed: true,
      ai_autoreply_disabled: true,
    })
    expect(h.state.noteInserts).toHaveLength(1)
    expect(h.state.noteInserts[0].note_text).not.toContain('etiqueta')
    expect(h.state.noteInserts[0].note_text).not.toContain('movido')
  })

  it('is a one-shot no-op when the conversation already claimed handoff_completed', async () => {
    h.state.conversationClaimed = false
    const db = makeDb()
    await applyProfileHandoff({ db, ...ARGS, profile: profile() })

    expect(h.resolveImportTagIds).not.toHaveBeenCalled()
    expect(h.state.noteInserts).toHaveLength(0)
  })

  it('logs a note without the stage clause when the named stage cannot be found', async () => {
    h.state.stage = null
    const db = makeDb()
    await applyProfileHandoff({ db, ...ARGS, profile: profile() })

    expect(h.state.dealInsertPayload).toBeNull()
    expect(h.state.noteInserts[0].note_text).toContain('etiqueta')
    expect(h.state.noteInserts[0].note_text).not.toContain('movido')
  })

  it('never throws even if a downstream step fails', async () => {
    h.resolveImportTagIds.mockRejectedValue(new Error('boom'))
    const db = makeDb()
    await expect(
      applyProfileHandoff({ db, ...ARGS, profile: profile() }),
    ).resolves.toBeUndefined()
    // Tagging failed, but the rest still ran.
    expect(h.state.noteInserts).toHaveLength(1)
  })
})
