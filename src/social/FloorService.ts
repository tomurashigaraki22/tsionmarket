import type { Pool, RowDataPacket } from 'mysql2/promise'
import { AppError } from '../utils/errors.js'
import type { FloorRepository, FeedSort } from './FloorRepository.js'
import type { ProfileRepository } from './ProfileRepository.js'
import { containsLink, mayPostLinks } from './rules.js'

const POPULAR_WINDOW_DAYS = 7
const MAX_REPLIES_INLINE = 50
const REPORT_QUEUE_LIMIT = 100

/**
 * How settled an account must be before it can post.
 *
 * Free, and it removes most drive-by spam: a throwaway registered to push a
 * link has to wait, which is exactly the cost a bulk operation will not pay.
 */
const MIN_ACCOUNT_AGE_MINUTES = 30

export class FloorService {
  constructor(
    private readonly floor: FloorRepository,
    private readonly profiles: ProfileRepository,
    private readonly pool: Pool,
  ) {}

  feed(viewerId: string, query: { sort: FeedSort; limit: number; cursor?: string | undefined }) {
    return this.floor.feed({ ...query, viewerId, popularWindowDays: POPULAR_WINDOW_DAYS })
  }

  async thread(id: string, viewerId: string) {
    const post = await this.floor.byId(id, viewerId)
    if (!post) throw new AppError('POST_NOT_FOUND', 'That post no longer exists', 404)
    return { post, replies: await this.floor.replies(id, viewerId, MAX_REPLIES_INLINE) }
  }

  async publish(
    userId: string,
    input: { body: string; citedMarketId?: string | undefined; replyToId?: string | undefined },
  ) {
    const profile = await this.profiles.byUserId(userId)
    if (!profile) throw new AppError('PROFILE_REQUIRED', 'Claim a handle before posting', 409)

    await this.assertCanPost(userId)

    // The post is refused rather than silently stripped, so the author knows
    // what happened instead of watching their link vanish.
    if (containsLink(input.body) && !mayPostLinks(profile.role))
      throw new AppError('LINKS_NOT_ALLOWED', 'Only verified accounts can post links', 403)

    if (input.citedMarketId && !(await this.floor.marketExists(input.citedMarketId)))
      throw new AppError('MARKET_NOT_FOUND', 'That market is not in the catalogue', 400)

    const id = await this.floor.create({ authorId: userId, ...input })
    const created = await this.floor.byId(id, userId)
    if (!created) throw new AppError('POST_CREATE_FAILED', 'Post could not be created', 500)
    return created
  }

  setLiked(postId: string, userId: string, liked: boolean) {
    return this.floor.setLiked(postId, userId, liked)
  }

  report(postId: string, reporterId: string, reason: string, detail?: string) {
    return this.floor.report({ postId, reporterId, reason, detail })
  }

  setBlocked(userId: string, blockedUserId: string, blocked: boolean) {
    return this.floor.setBlocked(userId, blockedUserId, blocked)
  }

  /**
   * Role is read from the profile rather than the access token: it is not a
   * session claim, so raising or revoking an account takes effect on the next
   * request instead of on the next token refresh.
   */
  async remove(id: string, userId: string) {
    const profile = await this.profiles.byUserId(userId)
    const isAdmin = profile?.role === 'admin'
    await this.floor.remove(id, userId, isAdmin)
    // Removing a reported post closes the reports that asked for it, so the
    // queue reflects outstanding work rather than settled cases.
    if (isAdmin) await this.floor.resolveReports(id, userId, 'actioned')
  }

  async reportQueue(userId: string) {
    await this.assertAdmin(userId)
    return this.floor.openReports(REPORT_QUEUE_LIMIT)
  }

  async dismissReports(postId: string, userId: string) {
    await this.assertAdmin(userId)
    await this.floor.resolveReports(postId, userId, 'dismissed')
  }

  private async assertAdmin(userId: string): Promise<void> {
    const profile = await this.profiles.byUserId(userId)
    if (profile?.role !== 'admin')
      throw new AppError('FORBIDDEN', 'Administrator access is required', 403)
  }

  /**
   * An unverified address is not an identity, and a minutes-old account is
   * the shape spam arrives in.
   */
  private async assertCanPost(userId: string): Promise<void> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT email_verified_at AS emailVerifiedAt,
        TIMESTAMPDIFF(MINUTE, created_at, NOW(6)) AS ageMinutes
       FROM users WHERE id = ?`,
      [userId],
    )
    const account = rows[0] as { emailVerifiedAt: string | null; ageMinutes: number } | undefined
    if (!account) throw new AppError('AUTH_REQUIRED', 'Authentication required', 401)
    if (!account.emailVerifiedAt)
      throw new AppError('EMAIL_VERIFICATION_REQUIRED', 'Verify your email to post', 403)
    if (Number(account.ageMinutes) < MIN_ACCOUNT_AGE_MINUTES)
      throw new AppError(
        'ACCOUNT_TOO_NEW',
        `New accounts can post after ${MIN_ACCOUNT_AGE_MINUTES} minutes`,
        403,
      )
  }
}
