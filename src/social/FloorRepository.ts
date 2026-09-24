/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment -- mysql2 RowDataPacket values cross a runtime database boundary */
import { randomUUID } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import { withTransaction } from '../db/transaction.js'
import { AppError } from '../utils/errors.js'

export type FeedSort = 'latest' | 'popular'

export type FloorPostInput = {
  authorId: string
  body: string
  citedMarketId?: string | undefined
  replyToId?: string | undefined
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
function decode(value?: string): { key: string; id: string } | undefined {
  if (!value) return
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString())
  } catch {
    return
  }
}

/**
 * Author identity comes from user_profiles, never from users: this join is the
 * reason an email cannot reach a feed response by accident.
 */
const POST_COLUMNS = `f.id, f.body, f.cited_market_id AS citedMarketId,
  f.reply_to_id AS replyToId, f.like_count AS likeCount, f.reply_count AS replyCount,
  f.created_at AS createdAt,
  p.user_id AS authorId, p.handle AS authorHandle, p.display_name AS authorName,
  p.avatar_seed AS authorAvatarSeed, u.role AS authorRole,
  m.base_symbol AS citedSymbol, m.network_id AS citedNetworkId,
  CAST(m.price_usd AS CHAR) AS citedPriceUsd,
  CAST(m.price_change_24h_pct AS CHAR) AS citedPriceChange24hPct`

const POST_JOINS = `FROM floor_posts f
  JOIN user_profiles p ON p.user_id = f.author_id
  JOIN users u ON u.id = f.author_id
  LEFT JOIN spot_markets m ON m.market_id = f.cited_market_id`

/**
 * Whether the viewer has liked each row, resolved in the same query as the
 * page. A second round trip per post would be one request per row.
 */
const LIKED_BY_ME = `EXISTS (
  SELECT 1 FROM floor_post_likes l WHERE l.post_id = f.id AND l.user_id = ?
) AS likedByMe`

/**
 * Blocking hides in both directions: the blocker stops seeing that author,
 * and the blocked account stops seeing the blocker. Hiding one way only
 * leaves the blocked person free to read and reply.
 */
const NOT_BLOCKED = `NOT EXISTS (
  SELECT 1 FROM floor_blocks b
  WHERE (b.user_id = ? AND b.blocked_user_id = f.author_id)
     OR (b.user_id = f.author_id AND b.blocked_user_id = ?)
)`

export class FloorRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Top-level posts only. Replies are fetched with their parent, so a reply
   * never appears twice — once inline and once as its own feed entry.
   *
   * 'popular' ranks over a trailing window rather than all time: ordering by
   * like_count alone freezes the top of the feed on the oldest good post.
   */
  async feed(query: {
    viewerId: string
    sort: FeedSort
    limit: number
    cursor?: string | undefined
    popularWindowDays: number
  }) {
    const cursor = decode(query.cursor)
    const where = [`f.status = 'visible'`, `f.reply_to_id IS NULL`, NOT_BLOCKED]
    // Ordered to match the placeholders: the liked-by-me subselect is in the
    // SELECT list, the block filter in the WHERE.
    const params: Array<string | number> = [query.viewerId, query.viewerId, query.viewerId]

    if (query.sort === 'popular') {
      where.push('f.created_at >= DATE_SUB(NOW(6), INTERVAL ? DAY)')
      params.push(query.popularWindowDays)
    }
    if (cursor) {
      // The sort key is part of the cursor so paging stays total under ties.
      where.push(
        query.sort === 'popular'
          ? '(f.like_count < ? OR (f.like_count = ? AND f.id > ?))'
          : '(f.created_at < ? OR (f.created_at = ? AND f.id > ?))',
      )
      params.push(cursor.key, cursor.key, cursor.id)
    }
    params.push(query.limit + 1)

    const order =
      query.sort === 'popular'
        ? 'f.like_count DESC, f.id ASC'
        : 'f.created_at DESC, f.id ASC'

    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT ${POST_COLUMNS}, ${LIKED_BY_ME} ${POST_JOINS}
       WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
      params,
    )

    const hasMore = rows.length > query.limit
    const items = rows.slice(0, query.limit)
    const last = items.at(-1)
    return {
      items,
      nextCursor:
        hasMore && last
          ? encode({
              key: query.sort === 'popular' ? String(last.likeCount) : String(last.createdAt),
              id: last.id,
            })
          : null,
    }
  }

  async byId(id: string, viewerId: string) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT ${POST_COLUMNS}, ${LIKED_BY_ME} ${POST_JOINS}
       WHERE f.id = ? AND f.status = 'visible' AND ${NOT_BLOCKED}`,
      [viewerId, id, viewerId, viewerId],
    )
    return rows[0] ?? null
  }

  async replies(parentId: string, viewerId: string, limit: number) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT ${POST_COLUMNS}, ${LIKED_BY_ME} ${POST_JOINS}
       WHERE f.reply_to_id = ? AND f.status = 'visible' AND ${NOT_BLOCKED}
       ORDER BY f.created_at ASC, f.id ASC LIMIT ?`,
      [viewerId, parentId, viewerId, viewerId, limit],
    )
    return rows
  }

  /**
   * Like and unlike. The insert is IGNOREd and the delete checks its own
   * affected rows, so the counter only moves when the set of likers actually
   * changed — a retry cannot inflate it.
   */
  async setLiked(postId: string, userId: string, liked: boolean): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const [post] = await connection.execute<RowDataPacket[]>(
        `SELECT id FROM floor_posts WHERE id = ? AND status = 'visible' FOR UPDATE`,
        [postId],
      )
      if (!post[0]) throw new AppError('POST_NOT_FOUND', 'That post no longer exists', 404)

      const [result] = await connection.execute(
        liked
          ? 'INSERT IGNORE INTO floor_post_likes (post_id, user_id) VALUES (?, ?)'
          : 'DELETE FROM floor_post_likes WHERE post_id = ? AND user_id = ?',
        [postId, userId],
      )
      const changed = (result as { affectedRows?: number }).affectedRows ?? 0
      if (changed === 0) return

      await connection.execute(
        liked
          ? 'UPDATE floor_posts SET like_count = like_count + 1 WHERE id = ?'
          : 'UPDATE floor_posts SET like_count = GREATEST(like_count, 1) - 1 WHERE id = ?',
        [postId],
      )
    })
  }

  async report(input: {
    postId: string
    reporterId: string
    reason: string
    detail?: string | undefined
  }): Promise<void> {
    const [post] = await this.pool.execute<RowDataPacket[]>(
      `SELECT author_id AS authorId FROM floor_posts WHERE id = ? AND status = 'visible'`,
      [input.postId],
    )
    const author = post[0] as { authorId: string } | undefined
    if (!author) throw new AppError('POST_NOT_FOUND', 'That post no longer exists', 404)
    if (author.authorId === input.reporterId)
      throw new AppError('CANNOT_REPORT_OWN_POST', 'You cannot report your own post', 400)

    try {
      await this.pool.execute(
        `INSERT INTO floor_reports (id, post_id, reporter_id, reason, detail)
         VALUES (?, ?, ?, ?, ?)`,
        [randomUUID(), input.postId, input.reporterId, input.reason, input.detail ?? null],
      )
    } catch (error) {
      // Reporting the same post twice is not an error worth showing: the
      // report is already filed.
      if ((error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error
    }
  }

  async setBlocked(userId: string, blockedUserId: string, blocked: boolean): Promise<void> {
    if (userId === blockedUserId)
      throw new AppError('CANNOT_BLOCK_SELF', 'You cannot block yourself', 400)
    await this.pool.execute(
      blocked
        ? 'INSERT IGNORE INTO floor_blocks (user_id, blocked_user_id) VALUES (?, ?)'
        : 'DELETE FROM floor_blocks WHERE user_id = ? AND blocked_user_id = ?',
      [userId, blockedUserId],
    )
  }

  /** The moderation queue: open reports, newest first, with the post's text. */
  async openReports(limit: number) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT r.id, r.post_id AS postId, r.reason, r.detail, r.created_at AS createdAt,
        f.body, f.status AS postStatus, p.handle AS authorHandle,
        (SELECT COUNT(*) FROM floor_reports x WHERE x.post_id = r.post_id AND x.status = 'open') AS reportCount
       FROM floor_reports r
       JOIN floor_posts f ON f.id = r.post_id
       JOIN user_profiles p ON p.user_id = f.author_id
       WHERE r.status = 'open'
       ORDER BY r.created_at DESC LIMIT ?`,
      [limit],
    )
    return rows
  }

  async resolveReports(postId: string, adminId: string, status: 'actioned' | 'dismissed') {
    await this.pool.execute(
      `UPDATE floor_reports SET status = ?, resolved_by = ?, resolved_at = NOW(6)
       WHERE post_id = ? AND status = 'open'`,
      [status, adminId, postId],
    )
  }

  async create(input: FloorPostInput): Promise<string> {
    const id = randomUUID()
    await withTransaction(this.pool, async (connection) => {
      if (input.replyToId) {
        const [parents] = await connection.execute<RowDataPacket[]>(
          `SELECT id, reply_to_id AS replyToId FROM floor_posts
           WHERE id = ? AND status = 'visible' FOR UPDATE`,
          [input.replyToId],
        )
        const parent = parents[0] as { replyToId: string | null } | undefined
        if (!parent) throw new AppError('POST_NOT_FOUND', 'That post no longer exists', 404)
        // One level only. Replying to a reply attaches to its parent instead
        // of growing a thread the feed cannot render or paginate.
        if (parent.replyToId)
          throw new AppError('REPLY_DEPTH_EXCEEDED', 'Replies cannot be nested further', 400)
      }

      await connection.execute(
        `INSERT INTO floor_posts (id, author_id, body, cited_market_id, reply_to_id)
         VALUES (?, ?, ?, ?, ?)`,
        [
          id,
          input.authorId,
          input.body,
          input.citedMarketId ?? null,
          input.replyToId ?? null,
        ],
      )

      // Counter and row move together, so a count can never drift from the
      // rows behind it.
      if (input.replyToId)
        await connection.execute(
          'UPDATE floor_posts SET reply_count = reply_count + 1 WHERE id = ?',
          [input.replyToId],
        )
    })
    return id
  }

  /** Author-only. Removing a parent cascades its replies out of every feed. */
  async remove(id: string, userId: string, isAdmin: boolean): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT author_id AS authorId, reply_to_id AS replyToId FROM floor_posts
         WHERE id = ? AND status = 'visible' FOR UPDATE`,
        [id],
      )
      const post = rows[0] as { authorId: string; replyToId: string | null } | undefined
      if (!post) throw new AppError('POST_NOT_FOUND', 'That post no longer exists', 404)
      if (post.authorId !== userId && !isAdmin)
        throw new AppError('POST_NOT_OWNED', 'You can only delete your own posts', 403)

      await connection.execute(
        `UPDATE floor_posts SET status = 'removed', deleted_at = NOW(6) WHERE id = ?`,
        [id],
      )
      // Replies to a removed post are removed with it: leaving them orphaned
      // shows half a conversation whose context is gone.
      await connection.execute(
        `UPDATE floor_posts SET status = 'removed', deleted_at = NOW(6)
         WHERE reply_to_id = ? AND status = 'visible'`,
        [id],
      )
      if (post.replyToId)
        await connection.execute(
          'UPDATE floor_posts SET reply_count = GREATEST(reply_count, 1) - 1 WHERE id = ?',
          [post.replyToId],
        )
    })
  }

  /** Whether a cited market exists, so an unresolvable citation is refused. */
  async marketExists(marketId: string): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM spot_markets WHERE market_id = ? AND active = TRUE`,
      [marketId],
    )
    return Boolean(rows[0])
  }
}
