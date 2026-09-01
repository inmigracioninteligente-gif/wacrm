import type { SupabaseClient } from '@supabase/supabase-js'
import type { MenuProfile } from './menu-router'

const PROFILE_COLUMNS =
  'id, name, menu_label, extra_keywords, position, system_prompt, is_active, handoff_tag, handoff_pipeline_stage'

export interface AgentProfile extends MenuProfile {
  name: string
  system_prompt: string
  is_active: boolean
  /** Tag name to add to the contact when this profile's objective is
   *  reached (`[[HANDOFF_READY]]`). Null = skip. */
  handoff_tag: string | null
  /** Pipeline stage name to move/create the contact's deal into when
   *  this profile's objective is reached. Null = skip. */
  handoff_pipeline_stage: string | null
}

/**
 * Active profiles for an account, ordered by `position` — the set the
 * menu router builds the numbered menu from and matches replies against.
 */
export async function loadActiveAgentProfiles(
  db: SupabaseClient,
  accountId: string,
): Promise<AgentProfile[]> {
  const { data, error } = await db
    .from('ai_agent_profiles')
    .select(PROFILE_COLUMNS)
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('position', { ascending: true })

  if (error) throw error
  return (data ?? []) as AgentProfile[]
}

/**
 * Load a single profile by id, scoped to the account (defensive — a
 * profile id should always belong to the caller's account, but this
 * avoids ever leaking another account's system prompt on a stale/tampered
 * `active_agent_profile_id`).
 */
export async function loadAgentProfileById(
  db: SupabaseClient,
  accountId: string,
  profileId: string,
): Promise<AgentProfile | null> {
  const { data, error } = await db
    .from('ai_agent_profiles')
    .select(PROFILE_COLUMNS)
    .eq('account_id', accountId)
    .eq('id', profileId)
    .maybeSingle()

  if (error) throw error
  return (data as AgentProfile | null) ?? null
}
