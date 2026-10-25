-- ============================================================
-- 036 — Twilio WhatsApp channel (relay from an external app)
--
-- Lets a workspace run its inbox on a WhatsApp number that lives in
-- Twilio instead of Meta Cloud API. The number's inbound webhook in
-- Twilio stays pointed at the app that already owns it (e.g. the
-- AsiloCheck bot). That app relays a copy of every event to
-- ParaDesk's `/api/channels/twilio/ingest` endpoint, authenticated
-- with a per-workspace secret. Agent replies from the inbox go out
-- through the Twilio REST API with the credentials stored here.
--
-- Kept in its own table (not extra columns on whatsapp_config) on
-- purpose: ~20 code paths read whatsapp_config and call the Meta API
-- with whatever they find. A Twilio row there would make every one of
-- them send Meta requests with Twilio credentials.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS twilio_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Admin who saved the config. Used as the NOT NULL user_id on the
  -- contacts / conversations the relay creates (same convention as
  -- whatsapp_config.user_id in the Meta webhook).
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_sid TEXT NOT NULL,
  -- AES-256-GCM, same format as whatsapp_config.access_token.
  auth_token TEXT NOT NULL,
  -- Business number in E.164 with a leading '+', e.g. +17863860961.
  from_number TEXT NOT NULL,
  -- SHA-256 (hex) of the relay secret. The plain secret is shown to
  -- the admin once, at generation time, and never stored.
  ingest_secret_hash TEXT NOT NULL,
  -- Random token embedded in the Twilio StatusCallback URL so delivery
  -- receipts for agent replies can be matched to this account.
  status_token TEXT NOT NULL,
  -- Public origin of this ParaDesk deployment, captured when the
  -- config is saved; used to build the StatusCallback URL.
  public_base_url TEXT,
  status TEXT NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'disconnected')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'twilio_config_account_id_key') THEN
    ALTER TABLE twilio_config ADD CONSTRAINT twilio_config_account_id_key UNIQUE (account_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'twilio_config_from_number_key') THEN
    ALTER TABLE twilio_config ADD CONSTRAINT twilio_config_from_number_key UNIQUE (from_number);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_twilio_config_ingest_secret_hash
  ON twilio_config (ingest_secret_hash);
CREATE INDEX IF NOT EXISTS idx_twilio_config_status_token
  ON twilio_config (status_token);

ALTER TABLE twilio_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS twilio_config_select ON twilio_config;
DROP POLICY IF EXISTS twilio_config_insert ON twilio_config;
DROP POLICY IF EXISTS twilio_config_update ON twilio_config;
DROP POLICY IF EXISTS twilio_config_delete ON twilio_config;
CREATE POLICY twilio_config_select ON twilio_config FOR SELECT USING (is_account_member(account_id));
CREATE POLICY twilio_config_insert ON twilio_config FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY twilio_config_update ON twilio_config FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY twilio_config_delete ON twilio_config FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON twilio_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON twilio_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- Context backlog: automated notices sent to people who have no
-- conversation yet. They are NOT turned into conversations (that
-- would flood the inbox with thousands of one-way notices). When the
-- person writes in for the first time, the most recent ones are moved
-- into the new conversation as context, then cleared.
-- Only the service role touches this table (RLS on, no policies).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS twilio_context_backlog (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Digits only, matches contacts.phone_normalized.
  phone_normalized TEXT NOT NULL,
  message_sid TEXT NOT NULL,
  body TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'twilio_context_backlog_sid_key') THEN
    ALTER TABLE twilio_context_backlog
      ADD CONSTRAINT twilio_context_backlog_sid_key UNIQUE (account_id, message_sid);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_twilio_context_backlog_phone
  ON twilio_context_backlog (account_id, phone_normalized, sent_at DESC);

ALTER TABLE twilio_context_backlog ENABLE ROW LEVEL SECURITY;
