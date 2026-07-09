-- ============================================================
-- 033_admin_notification_settings.sql — WhatsApp notifications
-- to the account admin when a customer message comes in.
--
-- Design notes
--   - `notification_settings` is account-scoped and UNIQUE(account_id),
--     one row per workspace — same shape as `ai_configs` / `whatsapp_config`.
--   - `admin_phone` is the *personal* number that receives the alert
--     template (paradesk_nuevo_mensaje), never the CRM's own business
--     number — that one stays free to talk to customers.
--   - `notify_mode` picks the trigger granularity:
--       'all'              → every inbound customer message
--       'new_contact_only' → only the contact's first-ever message
--     The webhook already computes "is this the first inbound message"
--     per message (see processMessage in the webhook route) — this
--     column just tells it whether to act on that flag.
--   - `enabled` is the master switch; off means the webhook never
--     calls out to Meta for this account regardless of notify_mode.
--
-- RLS mirrors `ai_configs`: any member (viewer+) can read (so the
-- settings UI can render current state), only admin+ can write. The
-- webhook always calls this through the service-role client, so RLS
-- guards the dashboard, not the send path.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_settings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  enabled       boolean NOT NULL DEFAULT false,
  notify_mode   text NOT NULL DEFAULT 'new_contact_only'
                  CHECK (notify_mode IN ('all', 'new_contact_only')),
  admin_phone   text NOT NULL DEFAULT '+19545405754',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_settings_select ON notification_settings;
CREATE POLICY notification_settings_select ON notification_settings FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS notification_settings_insert ON notification_settings;
CREATE POLICY notification_settings_insert ON notification_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS notification_settings_update ON notification_settings;
CREATE POLICY notification_settings_update ON notification_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS notification_settings_delete ON notification_settings;
CREATE POLICY notification_settings_delete ON notification_settings FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_notification_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_settings_updated_at ON notification_settings;
CREATE TRIGGER notification_settings_updated_at
  BEFORE UPDATE ON notification_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_notification_settings_updated_at();
