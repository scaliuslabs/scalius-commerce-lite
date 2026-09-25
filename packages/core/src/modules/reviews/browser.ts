// Browser-safe entry: pure types and constants only (no database, no domain
// index). Safe to import from the dashboard and from any domain.
// B1 fills the reviews domain; these names are the contract it keeps.

/** `product_reviews.status` (Wave B design §2.1). */
export const REVIEW_STATUSES = ["pending", "published", "rejected", "withdrawn"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * Why staff rejected a review. "Low rating" is deliberately not a reason:
 * moderation never depends on the star rating (design §2.1, FTC review rule).
 */
export const REVIEW_MODERATION_REASONS = [
  "spam",
  "abusive",
  "personal_info",
  "off_topic",
  "not_about_product",
] as const;
export type ReviewModerationReason = (typeof REVIEW_MODERATION_REASONS)[number];

/** `reviews.moderation` setting: publish after automatic checks, or hold every review. */
export const REVIEW_MODERATION_MODES = ["auto", "hold"] as const;
export type ReviewModerationMode = (typeof REVIEW_MODERATION_MODES)[number];

/** Bulk moderation actions (`POST /admin/reviews/moderate`). */
export const REVIEW_MODERATION_ACTIONS = ["publish", "reject", "restore"] as const;
export type ReviewModerationAction = (typeof REVIEW_MODERATION_ACTIONS)[number];

/** `product_reviews.author_type`. */
export const REVIEW_AUTHOR_TYPES = ["customer", "guest_receipt"] as const;
export type ReviewAuthorType = (typeof REVIEW_AUTHOR_TYPES)[number];

/** The per-order-line review fact composed into order responses (`extras.review`). */
export interface LineReviewExtra {
  /** The line can be reviewed now (delivered, fulfilled, within the window, not a gift card). */
  eligible: boolean;
  /** The buyer's review of this line, when one exists. */
  review: {
    id: string;
    rating: number;
    status: ReviewStatus;
  } | null;
}
