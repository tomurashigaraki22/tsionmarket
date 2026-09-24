import { AppError } from '../utils/errors.js'
import type { FloorRepository, FeedSort } from './FloorRepository.js'
import type { ProfileRepository } from './ProfileRepository.js'
import { containsLink, mayPostLinks } from './rules.js'

const POPULAR_WINDOW_DAYS = 7
const MAX_REPLIES_INLINE = 50

export class FloorService {
  constructor(
    private readonly floor: FloorRepository,
    private readonly profiles: ProfileRepository,
  ) {}

  feed(userId: string, query: { sort: FeedSort; limit: number; cursor?: string | undefined }) {
    void userId
    return this.floor.feed({ ...query, popularWindowDays: POPULAR_WINDOW_DAYS })
  }

  async thread(id: string) {
    const post = await this.floor.byId(id)
    if (!post) throw new AppError('POST_NOT_FOUND', 'That post no longer exists', 404)
    return { post, replies: await this.floor.replies(id, MAX_REPLIES_INLINE) }
  }

  /**
   * Posting requires a profile: the feed renders a handle, and an account
   * without one has nothing to render but its email.
   */
  async publish(
    userId: string,
    input: { body: string; citedMarketId?: string | undefined; replyToId?: string | undefined },
  ) {
    const profile = await this.profiles.byUserId(userId)
    if (!profile)
      throw new AppError('PROFILE_REQUIRED', 'Claim a handle before posting', 409)

    // Link policy: only verified accounts and admins may publish one. The
    // post is refused rather than silently stripped, so the author knows what
    // happened instead of watching their link vanish.
    if (containsLink(input.body) && !mayPostLinks(profile.role))
      throw new AppError(
        'LINKS_NOT_ALLOWED',
        'Only verified accounts can post links',
        403,
      )

    if (input.citedMarketId && !(await this.floor.marketExists(input.citedMarketId)))
      throw new AppError('MARKET_NOT_FOUND', 'That market is not in the catalogue', 400)

    const id = await this.floor.create({ authorId: userId, ...input })
    const created = await this.floor.byId(id)
    if (!created) throw new AppError('POST_CREATE_FAILED', 'Post could not be created', 500)
    return created
  }

  /**
   * Role is read from the profile rather than the access token: it is not a
   * session claim, so raising or revoking an account takes effect on the next
   * request instead of on the next token refresh.
   */
  async remove(id: string, userId: string) {
    const profile = await this.profiles.byUserId(userId)
    await this.floor.remove(id, userId, profile?.role === 'admin')
  }
}
