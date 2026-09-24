import { describe, expect, it } from 'vitest'
import { HANDLE_PATTERN, containsLink, mayPostLinks, normalizeHandle } from '../src/social/rules.js'
import { createPostSchema, createProfileSchema } from '../src/api/routes/social.js'

describe('handles', () => {
  it('normalises case, so a handle cannot be claimed twice by casing alone', () => {
    expect(normalizeHandle('  AdaOkonkwo ')).toBe('adaokonkwo')
  })

  it('accepts letters, numbers and underscores within length', () => {
    for (const handle of ['ada', 'ada_okonkwo', 'trader_01', 'a'.repeat(20)])
      expect(HANDLE_PATTERN.test(handle)).toBe(true)
  })

  it('rejects handles that are too short, too long, or contain separators', () => {
    for (const handle of ['ab', 'a'.repeat(21), 'ada okonkwo', 'ada.okonkwo', 'ada-okonkwo', 'adá'])
      expect(HANDLE_PATTERN.test(handle)).toBe(false)
  })

  it('normalises before validating, so mixed case input is accepted', () => {
    expect(createProfileSchema.parse({ handle: 'Ada_01', displayName: 'Ada' }).handle).toBe('ada_01')
  })
})

describe('link policy', () => {
  it('lets only verified accounts and admins publish links', () => {
    expect(mayPostLinks('user')).toBe(false)
    expect(mayPostLinks('verified')).toBe(true)
    expect(mayPostLinks('admin')).toBe(true)
  })

  it('catches links a reader would act on, not just ones a parser accepts', () => {
    for (const body of [
      'check https://drainer.example.com',
      'go to www.drainer.co now',
      'claim at drainer.xyz',
      'airdrop at tsion-market.finance',
      // A homoglyph dot reads as a domain to a human but not to a URL parser.
      'visit drainer．com',
    ])
      expect(containsLink(body)).toBe(true)
  })

  it('does not treat ordinary prose or a price as a link', () => {
    for (const body of [
      'SOL is up 14% today, no idea why',
      'bought at 118.93 and sold at 120.01',
      'the 4h close was decisive',
      'e.g. this is fine',
    ])
      expect(containsLink(body)).toBe(false)
  })
})

describe('post input', () => {
  it('holds a post to the column length', () => {
    expect(() => createPostSchema.parse({ body: 'a'.repeat(501) })).toThrow()
    expect(createPostSchema.parse({ body: 'a'.repeat(500) }).body).toHaveLength(500)
  })

  it('rejects an empty or whitespace-only post', () => {
    for (const body of ['', '   ', '\n']) expect(() => createPostSchema.parse({ body })).toThrow()
  })

  it('rejects unknown fields rather than silently dropping them', () => {
    expect(() => createPostSchema.parse({ body: 'hi', likeCount: 9999 })).toThrow()
  })
})
