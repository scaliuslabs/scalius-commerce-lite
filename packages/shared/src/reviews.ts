/**
 * Product reviews: the vocabulary, the text rules and the one automatic
 * moderation check (Wave B §2). Pure, so the API, the dashboard and the
 * storefront agree, and the database CHECKs and the stats trigger use the same
 * numbers.
 *
 * Moderation is rating-blind by construction: `checkReviewContent` has no
 * rating input, so a 1★ and a 5★ review with the same text always get the same
 * outcome (FTC consumer-review rule; Google review snippet policy). "Low
 * rating" is never a rejection reason.
 *
 * Review text is buyer content: never put it in URLs, logs, queue payloads or
 * analytics.
 */

import type { FulfillmentType } from "./fulfilment";
import { toLatinDigits } from "./phone-input";

export const REVIEW_RATING_MIN = 1;
export const REVIEW_RATING_MAX = 5;
export const REVIEW_RATINGS = [1, 2, 3, 4, 5] as const;
export type ReviewRating = (typeof REVIEW_RATINGS)[number];

/** Lengths count Unicode code points, as SQLite `length()` and Postgres `char_length()` do. */
export const REVIEW_LIMITS = {
  titleLength: 120,
  bodyLength: 5_000,
  displayNameLength: 60,
  replyLength: 2_000,
  /** Merchant block list size and the longest block word or phrase. */
  blockWords: 50,
  blockWordLength: 40,
  /** Buyer edits per review per day (`edit_count_day`). */
  editsPerDay: 10,
  /** A line stays reviewable this long after its first fulfilment. */
  reviewWindowDays: 365,
} as const;

/** `pending` → `published` | `rejected`; `published` → `rejected` (staff) | `withdrawn` (buyer); `rejected` → `published` (staff restore). */
export const REVIEW_STATUSES = ["pending", "published", "rejected", "withdrawn"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Statuses that hold the (product, reviewer) slot: at most one live review per product per buyer. */
export const LIVE_REVIEW_STATUSES = ["pending", "published"] as const satisfies readonly ReviewStatus[];

export type ReviewActor = "buyer" | "staff";

const REVIEW_TRANSITIONS: Readonly<Record<ReviewStatus, readonly { to: ReviewStatus; by: ReviewActor | "system" }[]>> = {
  pending: [
    { to: "published", by: "staff" },
    { to: "published", by: "system" },
    { to: "rejected", by: "staff" },
  ],
  published: [
    { to: "rejected", by: "staff" },
    { to: "withdrawn", by: "buyer" },
    // A buyer edit in hold mode sends the review back for moderation.
    { to: "pending", by: "system" },
  ],
  rejected: [{ to: "published", by: "staff" }],
  withdrawn: [],
};

/** Whether `actor` may move a review from `from` to `to` (§2.1). `system` is the automatic check. */
export function canTransitionReviewStatus(from: ReviewStatus, to: ReviewStatus, actor: ReviewActor | "system"): boolean {
  return REVIEW_TRANSITIONS[from].some((transition) => transition.to === to && transition.by === actor);
}

/** Why staff rejected a review. A content reason is required; "low rating" is deliberately absent. */
export const REVIEW_REJECTION_REASONS = ["spam", "abusive", "personal_info", "off_topic", "not_about_product"] as const;
export type ReviewRejectionReason = (typeof REVIEW_REJECTION_REASONS)[number];

/** `auto` publishes reviews that pass `checkReviewContent`; `hold` sends every review to moderation. */
export const REVIEW_MODERATION_MODES = ["auto", "hold"] as const;
export type ReviewModerationMode = (typeof REVIEW_MODERATION_MODES)[number];
export const DEFAULT_REVIEW_MODERATION_MODE: ReviewModerationMode = "auto";

/** Line types a buyer may review. Gift-card lines are not reviewable. */
export const REVIEWABLE_FULFILLMENT_TYPES = ["ship", "pickup", "digital", "service"] as const satisfies readonly FulfillmentType[];

/** Review-request delay after delivery, in days (settings). */
export const REVIEW_REQUEST_DELAY_DAYS = { min: 1, max: 60, default: 7 } as const;

/** Shown when the order carries no usable name. English; the storefront localizes. */
export const REVIEW_FALLBACK_DISPLAY_NAME = "Verified buyer";

export function isReviewRating(value: unknown): value is ReviewRating {
  return typeof value === "number" && Number.isInteger(value) && value >= REVIEW_RATING_MIN && value <= REVIEW_RATING_MAX;
}

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === "string" && (REVIEW_STATUSES as readonly string[]).includes(value);
}

export function isReviewRejectionReason(value: unknown): value is ReviewRejectionReason {
  return typeof value === "string" && (REVIEW_REJECTION_REASONS as readonly string[]).includes(value);
}

export function isReviewModerationMode(value: unknown): value is ReviewModerationMode {
  return typeof value === "string" && (REVIEW_MODERATION_MODES as readonly string[]).includes(value);
}

export function isReviewableFulfillmentType(type: FulfillmentType): boolean {
  return (REVIEWABLE_FULFILLMENT_TYPES as readonly FulfillmentType[]).includes(type);
}

// ---------------------------------------------------------------------------
// Text

export type ReviewTextField = "title" | "body" | "displayName" | "reply";

const TEXT_RULES: Readonly<Record<ReviewTextField, { maxLength: number; multiline: boolean }>> = {
  title: { maxLength: REVIEW_LIMITS.titleLength, multiline: false },
  body: { maxLength: REVIEW_LIMITS.bodyLength, multiline: true },
  displayName: { maxLength: REVIEW_LIMITS.displayNameLength, multiline: false },
  reply: { maxLength: REVIEW_LIMITS.replyLength, multiline: true },
};

export type ReviewTextResult =
  /** `null` when the input is absent or blank: every review text field is optional. */
  | { ok: true; value: string | null }
  | { ok: false; reason: "not_text" | "too_long" | "invalid_characters" };

function characterLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

/** C0 and C1 control characters (and DEL). */
function isControlCode(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * C0/C1 control characters other than tab and line feed, and unpaired UTF-16
 * surrogates (not storable as UTF-8 text). Zero-width joiners stay allowed:
 * Bangla needs them.
 */
function hasInvalidCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * The one normalization for review title, body, display name and merchant
 * reply: NFC, CRLF/CR → LF, trimmed; control characters other than newline and
 * tab rejected; single-line fields (title, display name) reject newlines;
 * length in code points. Blank or absent → `{ ok: true, value: null }`.
 */
export function normalizeReviewText(input: unknown, field: ReviewTextField): ReviewTextResult {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false, reason: "not_text" };
  const rule = TEXT_RULES[field];
  const value = input.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (!value) return { ok: true, value: null };
  if (hasInvalidCharacter(value) || (!rule.multiline && value.includes("\n"))) {
    return { ok: false, reason: "invalid_characters" };
  }
  if (characterLength(value) > rule.maxLength) return { ok: false, reason: "too_long" };
  return { ok: true, value };
}

function firstGrapheme(value: string): string {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) {
    for (const { segment } of new Segmenter(undefined, { granularity: "grapheme" }).segment(value)) return segment;
    return "";
  }
  return String.fromCodePoint(value.codePointAt(0) ?? 0x20).trim();
}

function truncateCharacters(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

/**
 * The default public name for a reviewer: "First L." from the order name
 * ("Abdur Rob Badhon" → "Abdur B."), "First" for a single word, and
 * `REVIEW_FALLBACK_DISPLAY_NAME` when no letter is left. The initial is the
 * first grapheme of the last word that starts with a letter or digit, so a
 * Bangla initial keeps its vowel sign. Never longer than 60 characters.
 */
export function defaultReviewerDisplayName(fullName: string | null | undefined): string {
  const cleaned = (fullName ?? "")
    .normalize("NFC")
    .replace(/[^]/gu, (character) => (isControlCode(character.codePointAt(0)!) ? " " : character))
    .trim();
  const words = cleaned.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word));
  const firstWord = words[0];
  if (!firstWord) return REVIEW_FALLBACK_DISPLAY_NAME;
  const first = firstWord.slice(firstWord.search(/[\p{L}\p{N}]/u));
  const last = words.length > 1 ? words[words.length - 1]! : null;
  const lastFromLetter = last ? last.slice(last.search(/[\p{L}\p{N}]/u)) : "";
  const initial = lastFromLetter ? firstGrapheme(lastFromLetter).toUpperCase() : "";
  const suffix = initial ? ` ${initial}.` : "";
  const room = REVIEW_LIMITS.displayNameLength - characterLength(suffix);
  return `${truncateCharacters(first, room)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Automatic content check

/** Why the automatic check held a review. The order here is the order `flags` lists them in. */
export const REVIEW_CHECK_FLAGS = ["url", "email", "phone", "repeated_characters", "block_word"] as const;
export type ReviewCheckFlag = (typeof REVIEW_CHECK_FLAGS)[number];

export interface ReviewCheckContent {
  title?: string | null;
  body?: string | null;
}

export interface ReviewCheckOptions {
  /** The merchant block list (≤ 50 words or phrases, English or Bangla), already saved in settings. */
  blockWords?: readonly string[];
}

export interface ReviewCheckResult {
  hold: boolean;
  flags: ReviewCheckFlag[];
}

/** A run of one character longer than this holds the review (21 or more of the same non-space character in a row). */
export const REVIEW_REPEATED_CHARACTER_LIMIT = 20;

/**
 * Link rule: a scheme (`http://`, `https://`, `ftp://`), a `www.` host, or a
 * bare `host.tld` whose last label is one of the common TLDs below (so "e.g."
 * and "4.5" never match, but "bit.ly/x", "wa.me/880…", "shop.com.bd" do).
 */
const URL_PATTERNS = [
  /\b(?:https?|ftp):\/\//i,
  /\bwww\.[\p{L}\p{N}-]/iu,
  /(?<![\p{L}\p{N}@.-])[\p{L}\p{N}][\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)*\.(?:com|net|org|info|biz|io|co|bd|me|ly|gl|gg|link|site|online|store|shop|xyz|app|dev|page|top|club|live|in|pk|uk|us|tk|ml|ga|cf)(?![\p{L}\p{N}-])/iu,
];

/** `local@domain.tld`; the look-behind starts a match only where a local part starts (linear time). */
const EMAIL_PATTERN = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[a-z]{2,}/iu;

/**
 * A Bangladesh mobile number, after Bangla/Arabic-Indic digits become Latin:
 * `01[3-9]` + 8 digits, optionally written `+880 1…`, `880 1…`, `+88 01…` or
 * `88 01…`, with up to three spaces, dots, dashes or brackets between digits,
 * and no digit immediately before or after (so longer numbers never match).
 */
const PHONE_GAP = String.raw`[\s.()\-]{0,3}`;
const BD_PHONE_PATTERN = new RegExp(
  String.raw`(?<![\d+])(?:\+?${PHONE_GAP}8${PHONE_GAP}8${PHONE_GAP}(?:0${PHONE_GAP})?(?:0${PHONE_GAP})?|0${PHONE_GAP})1${PHONE_GAP}[3-9](?:${PHONE_GAP}\d){8}(?!\d)`,
  "u",
);

const REPEATED_CHARACTER_PATTERN = new RegExp(String.raw`(\S)\1{${REVIEW_REPEATED_CHARACTER_LIMIT},}`, "u");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Clean a merchant block list: NFC, trimmed, inner whitespace collapsed,
 * lowercased, blanks and duplicates dropped, at most 50 entries of at most 40
 * characters (longer entries are dropped, not cut, so a phrase never turns into
 * a shorter, broader one).
 */
export function normalizeReviewBlockWords(words: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const word of words) {
    if (typeof word !== "string") continue;
    const value = word.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
    if (!value || characterLength(value) > REVIEW_LIMITS.blockWordLength || hasInvalidCharacter(value)) continue;
    seen.add(value);
    if (seen.size === REVIEW_LIMITS.blockWords) break;
  }
  return [...seen];
}

/**
 * Case-insensitive, whole-word match: the word or phrase must not touch a
 * letter, digit or combining mark on either side, so "ass" never matches
 * "class" and a Bangla word never matches inside a longer word. Whitespace
 * inside a phrase matches any whitespace run.
 */
function containsBlockWord(text: string, blockWords: readonly string[]): boolean {
  for (const word of normalizeReviewBlockWords(blockWords)) {
    const pattern = word.split(" ").map(escapeRegExp).join(String.raw`\s+`);
    if (new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${pattern}(?![\\p{L}\\p{N}\\p{M}])`, "iu").test(text)) return true;
  }
  return false;
}

/**
 * The automatic moderation check (§2.1). Holds a review whose title or body
 * has a link, an email address, a Bangladesh mobile number, a run of more than
 * 20 identical non-space characters, or a merchant block word. It never
 * receives the rating: the outcome depends on the text alone.
 */
export function checkReviewContent(content: ReviewCheckContent, options: ReviewCheckOptions = {}): ReviewCheckResult {
  const text = [content.title, content.body]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map((part) => part.normalize("NFC"))
    .join("\n");
  const flags: ReviewCheckFlag[] = [];
  if (text) {
    if (URL_PATTERNS.some((pattern) => pattern.test(text))) flags.push("url");
    if (EMAIL_PATTERN.test(text)) flags.push("email");
    if (BD_PHONE_PATTERN.test(toLatinDigits(text))) flags.push("phone");
    if (REPEATED_CHARACTER_PATTERN.test(text)) flags.push("repeated_characters");
    if (options.blockWords && options.blockWords.length > 0 && containsBlockWord(text, options.blockWords)) {
      flags.push("block_word");
    }
  }
  return { hold: flags.length > 0, flags };
}

/**
 * The status a new or edited review gets: `published` only in `auto` mode
 * with a clean check, otherwise `pending`. Rating-blind like the check.
 */
export function reviewStatusAfterCheck(mode: ReviewModerationMode, check: ReviewCheckResult): "published" | "pending" {
  return mode === "auto" && !check.hold ? "published" : "pending";
}

// ---------------------------------------------------------------------------
// Aggregates (the `product_review_stats` trigger projection computes the same)

/** Bayesian prior: every product starts as if it had 5 reviews averaging 3★. */
export const REVIEW_RANK_PRIOR_COUNT = 5;
export const REVIEW_RANK_PRIOR_RATING = 3;

function assertCount(sum: number, count: number): void {
  if (!Number.isSafeInteger(sum) || !Number.isSafeInteger(count) || sum < 0 || count < 0) {
    throw new RangeError("Review aggregates are non-negative integers.");
  }
}

/**
 * `rating_rank_milli`, exactly as the stats trigger writes it:
 * `(rating_sum + 15) * 1000 / (review_count + 5)` in integer arithmetic,
 * truncated (SQLite and Postgres integer division), and `null` at zero
 * published reviews, so a product whose reviews were all withdrawn or rejected
 * sorts with never-reviewed products under `rating_rank_milli DESC NULLS LAST`.
 * One 5★ review (3333) never outranks 300 reviews at 4.8★ (4770).
 */
export function reviewRankMilli(ratingSum: number, reviewCount: number): number | null {
  assertCount(ratingSum, reviewCount);
  if (reviewCount === 0) return null;
  return Math.floor(
    ((ratingSum + REVIEW_RANK_PRIOR_RATING * REVIEW_RANK_PRIOR_COUNT) * 1000) / (reviewCount + REVIEW_RANK_PRIOR_COUNT),
  );
}

/**
 * `rating_avg_centi`: the average × 100, truncated (`rating_sum * 100 /
 * NULLIF(review_count, 0)`), so 14 / 3 = 4.666… → 466. `null` with no
 * published review. The "N★ & up" facet is `rating_avg_centi >= N * 100`
 * (`ratingFacetMinCenti`), so 3.99 is not "4★ & up".
 */
export function ratingAverageCenti(ratingSum: number, reviewCount: number): number | null {
  assertCount(ratingSum, reviewCount);
  if (reviewCount === 0) return null;
  return Math.floor((ratingSum * 100) / reviewCount);
}

/** The "N★ & up" facet values offered (§2.4), highest first. */
export const REVIEW_RATING_FACET_STARS = [4, 3, 2] as const;
export type ReviewRatingFacetStars = (typeof REVIEW_RATING_FACET_STARS)[number];

/** The `rating_avg_centi` lower bound for an "N★ & up" filter (`minRating=4` → 400). */
export function ratingFacetMinCenti(stars: ReviewRatingFacetStars): number {
  return stars * 100;
}
