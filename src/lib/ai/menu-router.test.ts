import { describe, it, expect } from 'vitest'
import { normalize, deriveKeywords, buildMenuMessage, matchProfile, type MenuProfile } from './menu-router'

const PROFILES: MenuProfile[] = [
  { id: 'ami', menu_label: 'Certificación AMI', extra_keywords: 'curso', position: 1 },
  {
    id: 'paradesk',
    menu_label: 'ParaDesk (herramientas para paralegales/preparadores)',
    extra_keywords: null,
    position: 2,
  },
  { id: 'soporte', menu_label: 'Soporte — ya soy cliente', extra_keywords: null, position: 3 },
]

describe('normalize', () => {
  it('lowercases and strips accents', () => {
    expect(normalize('Certificación AMI')).toBe('certificacion ami')
  })
})

describe('deriveKeywords', () => {
  it('tokenizes the label, drops stopwords, and adds extra_keywords', () => {
    expect(deriveKeywords(PROFILES[0])).toEqual(['certificacion', 'ami', 'curso'])
  })

  it('filters short/common Spanish stopwords out of the label', () => {
    const keywords = deriveKeywords(PROFILES[1])
    expect(keywords).not.toContain('para')
    expect(keywords).toContain('paradesk')
  })
})

describe('buildMenuMessage', () => {
  it('numbers active profiles 1..N in position order', () => {
    const msg = buildMenuMessage(PROFILES)
    expect(msg).toContain('1. Certificación AMI')
    expect(msg).toContain('2. ParaDesk (herramientas para paralegales/preparadores)')
    expect(msg).toContain('3. Soporte — ya soy cliente')
  })

  it('numbers contiguously even when position values have gaps', () => {
    const gapped: MenuProfile[] = [
      { id: 'a', menu_label: 'A', extra_keywords: null, position: 5 },
      { id: 'b', menu_label: 'B', extra_keywords: null, position: 10 },
    ]
    const msg = buildMenuMessage(gapped)
    expect(msg).toContain('1. A')
    expect(msg).toContain('2. B')
  })
})

describe('matchProfile', () => {
  it('matches a bare number to the profile at that menu position', () => {
    expect(matchProfile(PROFILES, '1')?.id).toBe('ami')
    expect(matchProfile(PROFILES, '2')?.id).toBe('paradesk')
    expect(matchProfile(PROFILES, 'la opcion 3 porfa')?.id).toBe('soporte')
  })

  it('returns null for a number out of range', () => {
    expect(matchProfile(PROFILES, '9')).toBeNull()
  })

  it('falls through to keyword matching when the message has more than one number', () => {
    expect(matchProfile(PROFILES, '1 o 2, no se cual')).toBeNull()
  })

  it('matches a label keyword case/accent-insensitively', () => {
    expect(matchProfile(PROFILES, 'quiero info de la CERTIFICACIÓN')?.id).toBe('ami')
    expect(matchProfile(PROFILES, 'me interesa AMI')?.id).toBe('ami')
  })

  it('matches an extra_keywords synonym not literally in the label', () => {
    expect(matchProfile(PROFILES, 'quiero saber del curso')?.id).toBe('ami')
  })

  it('matches soporte / ya soy cliente', () => {
    expect(matchProfile(PROFILES, 'ya soy cliente, tengo un problema')?.id).toBe('soporte')
  })

  it('returns null when nothing matches', () => {
    expect(matchProfile(PROFILES, 'buenos dias')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(matchProfile(PROFILES, '   ')).toBeNull()
  })
})
