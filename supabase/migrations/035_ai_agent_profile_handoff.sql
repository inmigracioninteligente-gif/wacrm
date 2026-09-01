-- ============================================================
-- 035_ai_agent_profile_handoff.sql — CRM handoff on profile completion
--
-- Extends the multi-profile AI agents (migration 034) so that when a
-- profile's conversation reaches its objective — the model's own closing
-- message, detected via the `[[HANDOFF_READY]]` sentinel (see
-- src/lib/ai/defaults.ts / generate.ts) — the CRM actually reflects it
-- instead of the AI quietly going quiet with no trace:
--   - tags the contact (if the profile configured `handoff_tag`)
--   - moves/creates the contact's deal into a named Pipeline stage (if
--     the profile configured `handoff_pipeline_stage`)
--   - turns off the AI for that conversation (same
--     `conversations.ai_autoreply_disabled` switch as the other AI
--     safeguards)
--   - logs an automated `contact_notes` entry so it's auditable from the
--     contact's existing detail view — no new UI needed
--
-- Design notes
--   - `handoff_tag` / `handoff_pipeline_stage` are plain nullable text on
--     the profile, not FKs — matches how `ai_agent_profiles` is already
--     edited as free text in Setup, and keeps a renamed/deleted tag or
--     stage a soft no-op (logged, not a hard failure) rather than an
--     orphaned FK. Blank means "skip that action for this profile" —
--     e.g. Soporte does neither.
--   - `conversations.handoff_completed` is the one-shot guard for
--     requirement 4e: claimed atomically in application code
--     (`UPDATE ... WHERE handoff_completed = false`, same optimistic
--     pattern as `claim_ai_reply_slot`) so a race between two inbound
--     messages can't apply the tag/stage/note twice.
--   - The Pipeline stage to reuse was decided by inspecting this
--     project's actual `pipeline_stages` (Sales Pipeline: New Lead,
--     Qualified, Proposal Sent, Negotiation, Won) — "Qualified" already
--     means exactly what both AMI and ParaDesk's closing message
--     represents (a screened lead ready for a human to follow up), so
--     no new near-duplicate stages were created. The tag
--     ("AMI - Lead" / "ParaDesk - Demo") is what differentiates the two
--     products within that shared stage.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_agent_profiles
  ADD COLUMN IF NOT EXISTS handoff_tag text;

ALTER TABLE ai_agent_profiles
  ADD COLUMN IF NOT EXISTS handoff_pipeline_stage text;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS handoff_completed boolean NOT NULL DEFAULT false;

-- Seed the two starter profiles (034) that have a real handoff action.
-- Matched by name, applied to every account that has them — the same
-- scope 034 seeded them into. Soporte and the migrated single-agent
-- profile are intentionally left NULL (no pipeline move for an existing
-- client, and the migrated profile is inactive/legacy).
UPDATE ai_agent_profiles
SET handoff_tag = 'AMI - Lead',
    handoff_pipeline_stage = 'Qualified'
WHERE name = 'Certificación AMI'
  AND handoff_tag IS NULL
  AND handoff_pipeline_stage IS NULL;

UPDATE ai_agent_profiles
SET handoff_tag = 'ParaDesk - Demo',
    handoff_pipeline_stage = 'Qualified'
WHERE name = 'ParaDesk'
  AND handoff_tag IS NULL
  AND handoff_pipeline_stage IS NULL;
