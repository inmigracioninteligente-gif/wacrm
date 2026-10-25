-- ============================================================
-- 037 — Twilio Content Template for admin alerts
--
-- Workspaces on a Twilio number (migration 036) can't use the Meta
-- "paradesk_nuevo_mensaje" template: templates are approved per
-- WhatsApp Business Account. The admin alert ("a customer wrote")
-- goes out through Twilio using this approved Content Template
-- (HX…), with variables {{1}} = contact, {{2}} = message preview.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE twilio_config
  ADD COLUMN IF NOT EXISTS notify_content_sid TEXT;
