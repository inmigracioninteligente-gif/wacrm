-- ============================================================
-- 032_upl_outbound_safeguard.sql — UPL safeguard for HUMAN-authored
-- outbound messages
--
-- Migration 031 added a UPL (Unauthorized Practice of Law) safeguard for
-- the AI auto-reply bot's inbound classification. That safeguard never
-- sees messages a human agent types by hand in the Inbox composer — this
-- migration adds the audit trail for a second, independent safeguard that
-- covers exactly that gap: before a human agent sends free-form text, the
-- draft is classified (mirror-image prompt — looking for the AGENT giving
-- specific legal advice or promising a case outcome, not the customer
-- asking a question). If flagged, the agent sees a dismissible warning
-- and explicitly chooses "Edit message" or "Send anyway" — this is a
-- warning, not a technical block.
--
-- Design notes
--   - `upl_outbound_warnings` is a dedicated, append-only audit table
--     rather than reusing `messages.flagged_legal_question` — that column's
--     existing semantics are "customer message escalated for review"
--     (031), and conflating agent-authored warnings into it would muddy
--     the existing inbound-escalation reporting. This table only gets a
--     row when a warning was actually shown to an agent.
--   - No `message_id` column: when the agent picks "Edit message" nothing
--     is ever sent, so there's no message row to reference for that
--     branch. Correlating the "sent anyway" branch to its resulting
--     message is a possible future enhancement, not needed for the
--     compliance reporting this exists for (how often the warning fires,
--     and whether agents heed it).
--   - INSERT is agent+ (the composer logs its own decision); SELECT is
--     admin+ only (compliance reporting, not a per-agent feature); no
--     UPDATE/DELETE policy — the log is immutable.
--   - `ai_configs.outbound_warnings_enabled` — per-account kill switch for
--     this safeguard (Settings → AI Agents), defaulting to on. When off,
--     the Inbox composer skips the `/api/ai/classify-outbound` call
--     entirely — no delay, no classification — rather than calling it and
--     discarding the result server-side, since the whole point of the
--     toggle is to let an account opt out of the added latency too.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS outbound_warnings_enabled BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS upl_outbound_warnings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- The agent who typed the flagged draft.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Snapshot of the flagged draft text at warning time.
  message_text TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('sent_anyway', 'edited')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_upl_outbound_warnings_account_created
  ON upl_outbound_warnings(account_id, created_at DESC);

ALTER TABLE upl_outbound_warnings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS upl_outbound_warnings_select ON upl_outbound_warnings;
DROP POLICY IF EXISTS upl_outbound_warnings_insert ON upl_outbound_warnings;

CREATE POLICY upl_outbound_warnings_select ON upl_outbound_warnings FOR SELECT
  USING (is_account_member(account_id, 'admin'));

CREATE POLICY upl_outbound_warnings_insert ON upl_outbound_warnings FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND user_id = auth.uid()
  );
