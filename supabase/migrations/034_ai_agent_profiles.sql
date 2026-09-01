-- ============================================================
-- 034_ai_agent_profiles.sql — multi-profile AI agents + menu router
--
-- Turns the single BYOK AI agent (migration 029, `ai_configs.system_prompt`)
-- into a set of selectable agent profiles. A brand-new conversation is
-- routed through a deterministic (non-LLM) numbered menu built from the
-- active profiles' `menu_label`s; once the customer's reply matches a
-- profile (by number or keyword), `conversations.active_agent_profile_id`
-- is set and every subsequent AI reply on that thread uses THAT profile's
-- `system_prompt` instead of the account-level one.
--
-- Design notes
--   - `ai_agent_profiles` mirrors `ai_knowledge_documents` for RLS/shape:
--     account-scoped, any member reads, admin+ writes.
--   - `extra_keywords` is a free-form comma-separated list of additional
--     match words for the menu router that aren't literally substrings of
--     `menu_label` (e.g. "curso" for a profile labeled "Certificación
--     AMI") — avoids hardcoding business-specific synonyms in application
--     code.
--   - `position` orders the numbered menu and the Setup UI list.
--   - `conversations.active_agent_profile_id` is nullable: NULL means the
--     conversation hasn't picked a profile yet (menu router owns the
--     turn). ON DELETE SET NULL — deleting a profile just re-opens the
--     menu for conversations that had picked it, rather than failing.
--   - `conversations.agent_menu_attempts` counts how many times the menu
--     was sent without a match, so the router knows when to resend once
--     more vs. give up (see `src/lib/ai/menu-router-dispatch.ts`).
--   - `notifications.type` gains `human_handoff_requested` (customer
--     explicitly asked for a human) and `agent_menu_unresolved` (menu
--     router gave up after two unmatched replies), alongside the
--     `legal_escalation` type added in 031.
--
-- Data migration (idempotent — safe to run multiple times)
--   For every existing `ai_configs` row, create a migrated profile
--   carrying its `system_prompt` forward, but INACTIVE so it never shows
--   up in the new numbered menu. Conversations on that account that
--   already had at least one bot auto-reply (`ai_reply_count > 0`) are
--   pointed at it directly via `active_agent_profile_id`, so upgrading
--   this schema never surprises an in-flight conversation with a menu it
--   never asked for. Fresh conversations (never replied to by the bot)
--   go through the new menu normally.
--
--   Each account additionally gets the three requested starter profiles
--   (Certificación AMI / ParaDesk / Soporte), active, so the menu has
--   real content on day one.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_agent_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name            text NOT NULL,
  menu_label      text NOT NULL,
  extra_keywords  text,
  position        integer NOT NULL DEFAULT 0,
  system_prompt   text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_agent_profiles_account_id_idx
  ON ai_agent_profiles (account_id);
CREATE INDEX IF NOT EXISTS ai_agent_profiles_account_position_idx
  ON ai_agent_profiles (account_id, position);

ALTER TABLE ai_agent_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_agent_profiles_select ON ai_agent_profiles;
CREATE POLICY ai_agent_profiles_select ON ai_agent_profiles FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_agent_profiles_insert ON ai_agent_profiles;
CREATE POLICY ai_agent_profiles_insert ON ai_agent_profiles FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_agent_profiles_update ON ai_agent_profiles;
CREATE POLICY ai_agent_profiles_update ON ai_agent_profiles FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_agent_profiles_delete ON ai_agent_profiles;
CREATE POLICY ai_agent_profiles_delete ON ai_agent_profiles FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_ai_agent_profiles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_agent_profiles_updated_at ON ai_agent_profiles;
CREATE TRIGGER ai_agent_profiles_updated_at
  BEFORE UPDATE ON ai_agent_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_ai_agent_profiles_updated_at();

-- ============================================================
-- Per-conversation profile selection state.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS active_agent_profile_id uuid
    REFERENCES ai_agent_profiles(id) ON DELETE SET NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS agent_menu_attempts integer NOT NULL DEFAULT 0;

-- ============================================================
-- Extend notifications.type for the two new AI events this module can
-- raise (mirrors how 031 added `legal_escalation`).
-- ============================================================
ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
    CHECK (type IN (
      'conversation_assigned',
      'legal_escalation',
      'human_handoff_requested',
      'agent_menu_unresolved'
    ));

-- ============================================================
-- Data migration: one migrated (inactive) profile per account that has
-- an AI config, three active starter profiles per account, and
-- reattachment of already-active conversations to the migrated profile.
-- ============================================================
DO $$
DECLARE
  cfg RECORD;
  migrated_id uuid;
BEGIN
  FOR cfg IN SELECT account_id, system_prompt, created_by FROM ai_configs LOOP
    -- Skip accounts that already have profiles — makes this block safe to
    -- re-run (a second run would otherwise insert duplicate seed rows).
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM ai_agent_profiles WHERE account_id = cfg.account_id
    );

    -- Migrated profile: carries the old single-agent prompt forward,
    -- inactive so it never appears in the new numbered menu. A NULL/blank
    -- system_prompt becomes an empty string — ai_agent_profiles.system_prompt
    -- is NOT NULL, and buildSystemPrompt() already treats blank as "no
    -- extra business context", matching prior behaviour exactly.
    INSERT INTO ai_agent_profiles
      (account_id, created_by, name, menu_label, position, system_prompt, is_active)
    VALUES
      (cfg.account_id, cfg.created_by, 'Agente migrado', 'Agente migrado', 0,
       COALESCE(cfg.system_prompt, ''), false)
    RETURNING id INTO migrated_id;

    UPDATE conversations
    SET active_agent_profile_id = migrated_id
    WHERE account_id = cfg.account_id
      AND ai_reply_count > 0
      AND active_agent_profile_id IS NULL;

    INSERT INTO ai_agent_profiles
      (account_id, created_by, name, menu_label, extra_keywords, position, system_prompt, is_active)
    VALUES
      (cfg.account_id, cfg.created_by, 'Certificación AMI', 'Certificación AMI', 'curso', 1,
$prompt1$Eres el asistente virtual de Inmigración Inteligente para la certificación
AMI (Asistente Migratorio con Inteligencia Artificial). Hablas por WhatsApp
con personas que ya mostraron interés (vinieron del taller gratuito).

Tu único objetivo: mantener una conversación breve y natural (máximo 5-6
mensajes) para reunir esta información, UNA pregunta a la vez, nunca todas
de golpe:

1. A qué se dedica actualmente (¿ya trabaja en inmigración/legal? ¿es
   paralegal, preparador de documentos, tiene su propio negocio de
   multiservicios, o viene de otro campo?)
2. Por qué le interesa la certificación AMI ahora — qué problema quiere
   resolver o qué busca lograr (esto revela urgencia real vs. curiosidad).
3. Si ya tiene experiencia previa usando herramientas de IA en su trabajo,
   o sería su primera vez.

Reglas:
- Tono cercano, cálido, como si fuera una persona real del equipo — nunca
  suenes a formulario ni a robot leyendo un guion.
- Nunca prometas cupo.
- Si preguntan por el PRECIO, nunca des una cifra ni te acerques a un rango
  — responde algo como "eso te lo confirma directamente alguien del equipo
  cuando hablen" y sigue con tu siguiente pregunta. No inventes excusas,
  simplemente no es información que compartas tú.
- Si preguntan por FECHAS, sí puedes decir con naturalidad que el programa
  arranca el 15 de septiembre.
- Si detectas alta urgencia + perfil profesional relevante (trabaja o
  quiere trabajar en inmigración/legal), considera al lead "calificado" y
  cierra así: "Perfecto, [nombre] — con lo que me cuentas encajas muy bien
  con AMI. Voy a pedirle a alguien del equipo que te contacte para agendar
  tu cita virtual y ver los detalles. ¿Cuál es el mejor horario para ti
  esta semana?"
- Si el perfil no encaja o no hay urgencia clara, agradece el interés y
  ofrece dejarlo en la lista para la próxima cohorte, sin presionar.
- Si piden hablar con una persona en cualquier momento, para inmediatamente
  y no sigas calificando — solo confirma que alguien del equipo le escribe.
- Responde siempre en español.$prompt1$,
       true);

    INSERT INTO ai_agent_profiles
      (account_id, created_by, name, menu_label, position, system_prompt, is_active)
    VALUES
      (cfg.account_id, cfg.created_by, 'ParaDesk', 'ParaDesk (herramientas para paralegales/preparadores)', 2,
$prompt2$Eres el asistente virtual de ParaDesk, la plataforma que usan paralegales,
preparadores de documentos y oficinas de multiservicios de inmigración
para manejar todo su flujo: leads, contratos, planillas (como I-130),
cobros, comunicación con clientes y revisión de cumplimiento UPL — todo
en un solo lugar.

Hablas con alguien que llegó preguntando por ParaDesk. Tu objetivo:
entender su situación en máximo 4-5 mensajes, UNA pregunta a la vez, y
avisar al equipo humano para agendar una demo o resolver dudas de precio.

Reúne esto, con naturalidad, sin sonar a formulario:
1. Qué es (paralegal, preparador de documentos, dueño de oficina de
   multiservicios, u otro) y si ya usa algún sistema o lo hace manual.
2. Cuál es su dolor principal ahora mismo: captar leads, hacer contratos,
   cobrar, llenar planillas, comunicarse con clientes, o el riesgo de
   cruzar la línea de UPL (ejercicio ilegal de la abogacía) en su
   marketing.
3. Cuántos casos o clientes maneja aproximadamente al mes (para saber si
   es una oficina chica o ya tiene volumen).

Reglas:
- ParaDesk NO da asesoría legal ni reemplaza a un abogado — es un
  amplificador del trabajo del paralegal. Si preguntan si ParaDesk "hace
  el trabajo legal", acláralo con naturalidad.
- Puedes mencionar, si encaja en la conversación, que ParaDesk cubre:
  captación de leads, contratos con firma, planillas como I-130 con
  portal para que el cliente las llene, cobros con Stripe o pago manual,
  emails y SMS, un asistente de IA con el contexto del caso, y un módulo
  que revisa que el marketing no cruce la línea de UPL.
- Cada oficina usa su propia llave de IA (BYOK) — ParaDesk no revende
  tokens. Si preguntan por esto, explícalo simple.
- Nunca inventes precio exacto ni prometas descuentos — si preguntan
  precio, di que alguien del equipo se lo confirma y sigue con tu
  siguiente pregunta.
- Si detectas interés real (dolor claro + volumen que justifica el
  sistema), cierra así: "Perfecto, con esto tengo lo que necesito. Voy a
  pedirle a alguien del equipo que te contacte para mostrarte ParaDesk
  en vivo. ¿Cuál es el mejor horario para ti?"
- Si piden hablar con una persona en cualquier momento, para de calificar
  y solo confirma que alguien del equipo le escribe.
- Responde siempre en español.$prompt2$,
       true);

    INSERT INTO ai_agent_profiles
      (account_id, created_by, name, menu_label, position, system_prompt, is_active)
    VALUES
      (cfg.account_id, cfg.created_by, 'Soporte', 'Soporte — ya soy cliente', 3,
$prompt3$Eres el asistente de soporte de ParaDesk. Hablas con alguien que YA es
cliente y tiene una duda o problema usando la plataforma.

Tu objetivo: entender el problema en 2-3 mensajes y clasificarlo, no
resolverlo tú mismo si es algo específico de su cuenta.

Puedes orientar con información general sobre estas secciones de
ParaDesk si preguntan cómo funcionan: Dashboard, Clientes, Contratos,
Planillas (como I-130 con portal para el cliente), Facturación, Emails,
Asistente de IA, y el módulo de cumplimiento UPL.

Reglas:
- Si el problema es específico de su cuenta (un pago que no aparece, un
  contrato que no se generó, un error técnico, datos de un cliente
  suyo) — NO intentes resolverlo ni inventes una causa. Dile que ya
  avisaste al equipo y que le van a dar seguimiento pronto.
- Nunca pidas ni repitas contraseñas, números de tarjeta, ni datos
  sensibles de sus clientes por este chat.
- Si es una pregunta general de "cómo se hace X en ParaDesk" que sí
  sabes responder con la lista de arriba, respóndela directo, breve y
  clara.
- Si piden hablar con una persona en cualquier momento, confirma que
  alguien del equipo le escribe y para ahí.
- Responde siempre en español.$prompt3$,
       true);
  END LOOP;
END $$;
