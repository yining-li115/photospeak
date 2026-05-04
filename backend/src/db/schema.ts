import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * One row per registered user. A user can sign in with Apple or with a
 * phone number; the row is the same — apple_user_id and phone are
 * independently nullable. Account deletion is soft (deleted_at set);
 * a daily job hard-deletes after a 7-day cooldown.
 */
export const users = pgTable(
  'users',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    appleUserId: text('apple_user_id').unique(),
    phone: text('phone'),
    email: text('email'),
    nickname: text('nickname').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    // Phone is unique only for active (non-deleted) users so a deleted
    // account doesn't permanently squat the number.
    phoneActiveIdx: uniqueIndex('users_phone_active_idx')
      .on(t.phone)
      .where(sql`${t.deletedAt} IS NULL AND ${t.phone} IS NOT NULL`),
  })
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/**
 * Refresh tokens — long-lived, server-stored so we can revoke them on
 * logout. Access tokens are short-lived JWTs that don't hit the DB.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    token: text('token').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index('refresh_tokens_user_idx').on(t.userId),
  })
);

export type RefreshToken = typeof refreshTokens.$inferSelect;
