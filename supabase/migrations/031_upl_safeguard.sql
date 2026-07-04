-- ============================================================
-- 031_upl_safeguard.sql — UPL (Unauthorized Practice of Law) safeguard
--
-- The AI reply assistant (migration 029) is used by immigration/legal-
-- adjacent businesses (e.g. AsiloCheck). An automatic reply that reads as
-- case-specific legal advice is a real UPL risk, so a classification step
-- runs on every inbound message — independent of whether auto-reply is
-- even enabled — and escalates anything that looks like a legal question
-- to a human instead of letting the bot answer it.
--
-- Design notes
--   - `ai_configs.legal_escalation_message` — the account's own copy for
--     the safe hand-off reply sent when a message is classified as a
--     legal question. Nullable, mirroring `system_prompt`: the app falls
--     back to a sane Spanish default in code when unset, so there's no
--     need to backfill existing rows here.
--   - `messages.flagged_legal_question` — audit trail so accounts can
--     report how many inbound messages were escalated for legal review.
--   - `notifications.type` gains `legal_escalation` so the safeguard can
--     alert the account's admins/owners the same way conversation
--     assignment already does. Inserted directly by the webhook's
--     service-role client (no client-side INSERT policy needed, same as
--     the existing `conversation_assigned` rows written by the trigger).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS legal_escalation_message text;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS flagged_legal_question boolean NOT NULL DEFAULT false;

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('conversation_assigned', 'legal_escalation'));
