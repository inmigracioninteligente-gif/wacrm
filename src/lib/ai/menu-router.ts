// ============================================================
// Menu router — deterministic (no LLM) profile selection.
//
// Before a conversation picks an `ai_agent_profiles` row, inbound
// messages are routed here instead of the LLM: a numbered menu is built
// from the active profiles' `menu_label`s, and the customer's reply is
// matched back to one of them by number or by keyword. Pure, synchronous
// functions — no DB/network access — so the matching rules are easy to
// unit-test independent of the dispatch/state-machine code in
// `menu-router-dispatch.ts`.
// ============================================================

export interface MenuProfile {
  id: string
  menu_label: string
  /** Comma-separated extra match words not literally in `menu_label`
   *  (e.g. "curso" for a profile labeled "Certificación AMI"). */
  extra_keywords: string | null
  position: number
}

/** Spanish stopwords short/common enough to be useless as match keywords. */
const STOPWORDS = new Set([
  'de', 'la', 'el', 'los', 'las', 'en', 'un', 'una', 'unos', 'unas',
  'con', 'para', 'ya', 'y', 'o', 'del', 'al', 'es', 'soy', 'mi', 'tu',
])

/** Lowercase + strip diacritics, so "Certificación" and "CERTIFICACION"
 *  and "certificación" all compare equal. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Match keywords for one profile: tokens from `menu_label`, plus any
 *  `extra_keywords`, minus stopwords/very short noise tokens. */
export function deriveKeywords(profile: Pick<MenuProfile, 'menu_label' | 'extra_keywords'>): string[] {
  const fromLabel = tokenize(profile.menu_label)
  const fromExtra = (profile.extra_keywords ?? '')
    .split(',')
    .map((w) => normalize(w))
    .filter(Boolean)

  const all = [...fromLabel, ...fromExtra]
  const seen = new Set<string>()
  const keywords: string[] = []
  for (const word of all) {
    if (word.length < 3 || STOPWORDS.has(word) || seen.has(word)) continue
    seen.add(word)
    keywords.push(word)
  }
  return keywords
}

function sortByPosition<T extends { position: number }>(profiles: T[]): T[] {
  return [...profiles].sort((a, b) => a.position - b.position)
}

/**
 * Build the numbered menu text sent to a customer who hasn't picked a
 * profile yet. Order follows `position`; numbering is always 1-based and
 * contiguous regardless of the underlying `position` values.
 */
export function buildMenuMessage(profiles: MenuProfile[]): string {
  const ordered = sortByPosition(profiles)
  const lines = ordered.map((p, i) => `${i + 1}. ${p.menu_label}`)
  return [
    '¿En qué te podemos ayudar? Responde con el número de la opción que te interese:',
    ...lines,
  ].join('\n')
}

/**
 * Match an inbound reply to one of the active profiles, in `position`
 * order (ties/ambiguity resolve to the earliest one) — first by a bare
 * number matching its 1-based menu position, then by keyword.
 * Returns `null` when nothing matches.
 */
export function matchProfile(profiles: MenuProfile[], inboundText: string): MenuProfile | null {
  const ordered = sortByPosition(profiles)
  const normalized = normalize(inboundText)
  if (!normalized) return null

  // Number match: only when the message contains exactly one distinct
  // number — "1" or "la opcion 1" match; "1 o 2" is ambiguous and falls
  // through to keyword matching instead of guessing.
  const numbers = [...new Set(normalized.match(/\d+/g) ?? [])]
  if (numbers.length === 1) {
    const index = Number(numbers[0]) - 1
    if (index >= 0 && index < ordered.length) return ordered[index]
  }

  // Keyword match: exact token match, or substring match for longer
  // keywords (>=4 chars) to also catch compound replies like
  // "quiero saber de certificacionami".
  const tokens = new Set(tokenize(normalized))
  for (const profile of ordered) {
    for (const keyword of deriveKeywords(profile)) {
      if (tokens.has(keyword)) return profile
      if (keyword.length >= 4 && normalized.includes(keyword)) return profile
    }
  }

  return null
}
