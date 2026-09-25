// Product reviews (Wave B §2). Every review is a verified purchase: one per
// order line (`UNIQUE(order_item_id)`), at most one live review per product
// per buyer, and a BEFORE INSERT trigger refuses any line that was not handed
// over on a delivered/completed order. `product_review_stats` is a trigger
// projection of the published reviews; nothing else writes it. Vocabulary and
// limits live in `@scalius/shared/reviews`.

import { sqliteTable, text, integer, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { products, productVariants } from "./products";
import { orders, orderItems } from "./orders";
import { customers } from "./customers";
import { user } from "./auth";

export const productReviews = sqliteTable("product_reviews", {
    /** `rev_` + random. */
    id: text("id").primaryKey(),
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
        .references(() => productVariants.id, { onDelete: "set null" }),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    orderItemId: text("order_item_id")
        .notNull()
        .references(() => orderItems.id, { onDelete: "cascade" }),
    /** `coalesce(orders.account_owner_customer_id, orders.customer_id)`: a customer record id, never PII. */
    reviewerKey: text("reviewer_key").notNull(),
    customerId: text("customer_id")
        .references(() => customers.id, { onDelete: "set null" }),
    authorType: text("author_type", { enum: ["customer", "guest_receipt"] }).notNull(),
    authorDisplayName: text("author_display_name").notNull(),
    variantLabel: text("variant_label"),
    rating: integer("rating").notNull(),
    title: text("title"),
    body: text("body"),
    status: text("status", { enum: ["pending", "published", "rejected", "withdrawn"] }).notNull().default("pending"),
    moderationReason: text("moderation_reason", {
        enum: ["spam", "abusive", "personal_info", "off_topic", "not_about_product"],
    }),
    /** JSON array of automatic-check flags (never the text itself). */
    checkFlags: text("check_flags"),
    publishedAt: integer("published_at"),
    replyBody: text("reply_body"),
    replyUserId: text("reply_user_id")
        .references(() => user.id, { onDelete: "set null" }),
    repliedAt: integer("replied_at"),
    /** Buyer edits on `edit_day` (days since epoch); capped at 10 a day. */
    editCountDay: integer("edit_count_day").notNull().default(0),
    editDay: integer("edit_day"),
    editedAt: integer("edited_at"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("product_reviews_order_item_unique").on(table.orderItemId),
    uniqueIndex("product_reviews_live_reviewer_unique")
        .on(table.productId, table.reviewerKey)
        .where(sql`${table.status} IN ('pending', 'published')`),
    index("product_reviews_product_published_idx")
        .on(table.productId, table.status, sql`${table.publishedAt} DESC`, table.id),
    index("product_reviews_status_created_idx").on(table.status, sql`${table.createdAt} DESC`, table.id),
    index("product_reviews_customer_idx")
        .on(table.customerId, sql`${table.createdAt} DESC`)
        .where(sql`${table.customerId} IS NOT NULL`),
    index("product_reviews_order_idx").on(table.orderId),
    check("product_reviews_id_shape", sql`substr(${table.id}, 1, 4) = 'rev_' AND length(${table.id}) BETWEEN 12 AND 68`),
    check("product_reviews_author_type_check", sql`${table.authorType} IN ('customer', 'guest_receipt')`),
    check("product_reviews_display_name_length", sql`length(trim(${table.authorDisplayName})) BETWEEN 1 AND 60`),
    check("product_reviews_rating_range", sql`${table.rating} BETWEEN 1 AND 5`),
    check("product_reviews_title_length", sql`${table.title} IS NULL OR length(${table.title}) BETWEEN 1 AND 120`),
    check("product_reviews_body_length", sql`${table.body} IS NULL OR length(${table.body}) BETWEEN 1 AND 5000`),
    check("product_reviews_status_check", sql`${table.status} IN ('pending', 'published', 'rejected', 'withdrawn')`),
    check("product_reviews_moderation_reason_check", sql`${table.moderationReason} IS NULL OR ${table.moderationReason} IN ('spam', 'abusive', 'personal_info', 'off_topic', 'not_about_product')`),
    check("product_reviews_rejected_has_reason", sql`${table.status} <> 'rejected' OR ${table.moderationReason} IS NOT NULL`),
    check("product_reviews_published_shape", sql`${table.status} <> 'published' OR ${table.publishedAt} IS NOT NULL`),
    check("product_reviews_check_flags_json", sql`${table.checkFlags} IS NULL OR (json_valid(${table.checkFlags}) AND length(${table.checkFlags}) <= 500)`),
    check("product_reviews_reply_length", sql`${table.replyBody} IS NULL OR length(${table.replyBody}) BETWEEN 1 AND 2000`),
    check("product_reviews_reply_shape", sql`(${table.replyBody} IS NULL) = (${table.repliedAt} IS NULL)`),
    check("product_reviews_edit_count_range", sql`${table.editCountDay} BETWEEN 0 AND 10`),
    check("product_reviews_version_positive", sql`${table.version} >= 1`),
    // Triggers: product_reviews_line_eligible (R1), product_reviews_stats_row,
    // product_reviews_stats_{add_insert,sub_update,add_update,sub_delete} (R3),
    // product_reviews_identity_immutable.
]);

/** One row per reviewed product: a trigger projection of its published reviews (R3). */
export const productReviewStats = sqliteTable("product_review_stats", {
    productId: text("product_id")
        .primaryKey()
        .references(() => products.id, { onDelete: "cascade" }),
    reviewCount: integer("review_count").notNull().default(0),
    ratingSum: integer("rating_sum").notNull().default(0),
    count1: integer("count_1").notNull().default(0),
    count2: integer("count_2").notNull().default(0),
    count3: integer("count_3").notNull().default(0),
    count4: integer("count_4").notNull().default(0),
    count5: integer("count_5").notNull().default(0),
    /** floor(average × 100); NULL at zero reviews. */
    ratingAvgCenti: integer("rating_avg_centi"),
    /** Bayesian sort key floor((sum + 3·5)·1000 / (count + 5)); NULL at zero reviews. */
    ratingRankMilli: integer("rating_rank_milli"),
    lastPublishedAt: integer("last_published_at"),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("product_review_stats_rank_idx").on(sql`${table.ratingRankMilli} DESC`, table.productId),
    index("product_review_stats_avg_idx").on(table.ratingAvgCenti, table.productId),
    index("product_review_stats_updated_idx").on(table.updatedAt),
    check("product_review_stats_counts_nonnegative", sql`${table.count1} >= 0 AND ${table.count2} >= 0 AND ${table.count3} >= 0 AND ${table.count4} >= 0 AND ${table.count5} >= 0`),
    check("product_review_stats_count_total", sql`${table.reviewCount} = ${table.count1} + ${table.count2} + ${table.count3} + ${table.count4} + ${table.count5}`),
    check("product_review_stats_sum_total", sql`${table.ratingSum} = ${table.count1} + 2 * ${table.count2} + 3 * ${table.count3} + 4 * ${table.count4} + 5 * ${table.count5}`),
    check("product_review_stats_average_shape", sql`(${table.reviewCount} = 0) = (${table.ratingAvgCenti} IS NULL) AND (${table.reviewCount} = 0) = (${table.ratingRankMilli} IS NULL)`),
]);

/** One review request per delivered order, recorded by a trigger on `orders.status`. */
export const orderReviewRequests = sqliteTable("order_review_requests", {
    orderId: text("order_id")
        .primaryKey()
        .references(() => orders.id, { onDelete: "cascade" }),
    deliveredAt: integer("delivered_at").notNull(),
    status: text("status", { enum: ["scheduled", "queued", "skipped"] }).notNull().default("scheduled"),
    /** The `review_request` outbox row once queued. */
    outboxId: text("outbox_id"),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("order_review_requests_status_delivered_idx").on(table.status, table.deliveredAt),
    check("order_review_requests_status_check", sql`${table.status} IN ('scheduled', 'queued', 'skipped')`),
    // Trigger on orders: orders_delivered_review_request.
]);

export type ProductReview = InferSelectModel<typeof productReviews>;
export type ProductReviewStats = InferSelectModel<typeof productReviewStats>;
export type OrderReviewRequest = InferSelectModel<typeof orderReviewRequests>;
