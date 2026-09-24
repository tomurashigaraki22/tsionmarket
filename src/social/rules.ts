/**
 * The pure rules behind the Floor: what a handle may be, and who may publish
 * a link. Kept out of the routes so they can be tested without a request.
 */
import type { UserRole } from './ProfileRepository.js'

export const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/

/**
 * Handles are stored and compared lower-case. The column is ascii_general_ci
 * so 'Ada' and 'ada' collide, but normalising on the way in means the stored
 * form is also what everyone sees.
 */
export function normalizeHandle(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Roles allowed to publish a URL.
 *
 * A feed beside a trading ticket is a drainer-link delivery mechanism, so the
 * default account cannot post one at all. Raising an account to 'verified' is
 * a deliberate act by an admin.
 */
const LINK_ROLES: ReadonlySet<UserRole> = new Set<UserRole>(['verified', 'admin'])

export function mayPostLinks(role: UserRole): boolean {
  return LINK_ROLES.has(role)
}

/**
 * Anything a reader could act on as a link.
 *
 * Deliberately broader than a URL parser: `tsion-market.co`, `bit.ly/x` and
 * `app﹒example﹒com` all read as links to a human even though only the first
 * two parse. Matching the human reading is the point — this decides whether to
 * reject a post, not how to render one.
 */
const LINK_PATTERNS: ReadonlyArray<RegExp> = [
  /\bhttps?:\/\//i,
  /\bwww\./i,
  // A bare domain: two or more labels ending in a plausible TLD.
  /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9][a-z0-9-]*)*\.(?:com|net|org|io|co|xyz|app|finance|fi|to|me|ly|gg|link|click|site|online|live|cash|money|exchange|capital|fund|dev|ai|sol|eth|crypto|wtf|lol|vip|pro|club|shop|store|info|biz|art|zip|mov)\b/i,
  // Homoglyph dots used to slip a domain past a naive check.
  /[．。﹒․]/,
]

export function containsLink(body: string): boolean {
  return LINK_PATTERNS.some((pattern) => pattern.test(body))
}
