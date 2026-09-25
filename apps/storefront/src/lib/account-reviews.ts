// Buyer reviews (Wave B §2.4, §9.2). This file holds the copy, the shapes the
// API returns, the outcome flags a form post comes back with, and the markup
// of the review form and of the buyer's own review. It is pure: the account
// Reviews page, the receipt (and track-order, which opens the receipt) and the
// browser-rendered account order page all render with it.
//
// Every form is a plain `method=post` to /api/reviews/submit, so it works
// before hydration and without JavaScript. The stars are radio inputs drawn
// with CSS. With JavaScript the same post goes through fetch, so an error
// keeps what the buyer typed. Review text only ever travels in a POST body:
// never a URL, a log line or analytics. A form carries ids, a same-origin
// return path and, on a receipt, the order id (the proof stays in its
// httpOnly cookie).
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import { escapeHtml } from "@scalius/shared/html-escape";
import { REVIEW_LIMITS } from "@scalius/shared/reviews";

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const REVIEW_FORM_COPY_KEYS = [
  "reviewWriteTitleText",
  "reviewRatingLabelText",
  "reviewStarOptionText",
  "reviewTitleLabelText",
  "reviewBodyLabelText",
  "reviewBodyPlaceholderText",
  "reviewNameLabelText",
  "reviewNameHelpText",
  "reviewSubmitText",
  "reviewSaveText",
  "reviewEditText",
  "reviewWithdrawText",
  "reviewWithdrawHelpText",
  "reviewYourReviewText",
  "reviewStatusPublishedText",
  "reviewStatusPendingText",
  "reviewStatusRejectedText",
  "reviewStatusWithdrawnText",
  "reviewPublishedNoticeText",
  "reviewPendingNoticeText",
  "reviewUpdatedNoticeText",
  "reviewWithdrawnNoticeText",
  "reviewRatingRequiredText",
  "reviewInvalidText",
  "reviewNotEligibleText",
  "reviewExistsText",
  "reviewEditExistingText",
  "reviewDisabledText",
  "reviewRateLimitedText",
  "reviewUnavailableText",
  "reviewChangedText",
  "reviewNotEditableText",
  "reviewSignInText",
  "reviewReceiptExpiredText",
  "reviewsAccountTitleText",
  "reviewsToReviewTitleText",
  "reviewsWrittenTitleText",
  "reviewsNothingToReviewText",
  "reviewsNoneWrittenText",
  "reviewOrderText",
  "reviewDeliveredOnText",
  "reviewsSignInTitleText",
  "reviewsSignInText",
  "reviewsUnavailableText",
  "reviewsRetryText",
  "reviewsReplyText",
  "reviewsReplyFallbackText",
  "reviewsEditedText",
  "reviewsRatedText",
] as const satisfies ReadonlyArray<keyof CheckoutLanguageData>;

export type ReviewFormCopy = Pick<CheckoutLanguageData, (typeof REVIEW_FORM_COPY_KEYS)[number]>;

/** The review copy from a resolved checkout language (en or bn, with the merchant's edits). Missing keys fall back to `fallback`. */
export function pickReviewFormCopy(copy: Partial<CheckoutLanguageData> | null | undefined, fallback: CheckoutLanguageData): ReviewFormCopy {
  return Object.fromEntries(REVIEW_FORM_COPY_KEYS.map((key) => {
    const value = copy?.[key];
    return [key, typeof value === "string" && value.trim() ? value : fallback[key]];
  })) as ReviewFormCopy;
}

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

export type BuyerReviewStatus = "pending" | "published" | "rejected" | "withdrawn";
const STATUSES: readonly BuyerReviewStatus[] = ["pending", "published", "rejected", "withdrawn"];

/** `items[].extras.review` on the receipt and the account order. */
export interface LineReviewExtra {
  eligible: boolean;
  review: { id: string; rating: number; status: BuyerReviewStatus } | null;
}

export interface BuyerReview {
  id: string;
  orderId: string;
  orderItemId: string;
  productId: string;
  productName: string;
  productSlug: string | null;
  variantLabel: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  displayName: string;
  status: BuyerReviewStatus;
  reply: { body: string; repliedAt: string } | null;
  createdAt: string;
  publishedAt: string | null;
  editedAt: string | null;
  version: number;
  canEdit: boolean;
}

export interface ReviewableLine {
  orderId: string;
  orderNumber: string;
  orderItemId: string;
  productId: string;
  productName: string;
  productSlug: string | null;
  variantLabel: string | null;
  imageUrl: string | null;
  fulfilledAt: string | null;
}

export interface BuyerReviews {
  toReview: ReviewableLine[];
  reviews: BuyerReview[];
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const isRating = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
const isStatus = (value: unknown): value is BuyerReviewStatus => typeof value === "string" && (STATUSES as readonly string[]).includes(value);

/** Review and order ids as the review routes accept them. */
export function isReviewId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function readLineReviewExtra(value: unknown): LineReviewExtra | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const review = raw.review && typeof raw.review === "object" ? raw.review as Record<string, unknown> : null;
  return {
    eligible: raw.eligible === true,
    review: review && isReviewId(review.id) && isRating(review.rating) && isStatus(review.status)
      ? { id: review.id, rating: review.rating, status: review.status }
      : null,
  };
}

function readBuyerReview(value: unknown): BuyerReview | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isReviewId(raw.id) || !isReviewId(raw.orderItemId) || !isRating(raw.rating) || !isStatus(raw.status)) return null;
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  const reply = raw.reply && typeof raw.reply === "object" ? raw.reply as Record<string, unknown> : null;
  return {
    id: raw.id,
    orderId: str(raw.orderId) ?? "",
    orderItemId: raw.orderItemId,
    productId: str(raw.productId) ?? "",
    productName: str(raw.productName) ?? "",
    productSlug: str(raw.productSlug),
    variantLabel: str(raw.variantLabel),
    rating: raw.rating,
    title: str(raw.title),
    body: str(raw.body),
    displayName: str(raw.displayName) ?? "",
    status: raw.status,
    reply: reply && str(reply.body) && str(reply.repliedAt) ? { body: String(reply.body), repliedAt: String(reply.repliedAt) } : null,
    createdAt: str(raw.createdAt) ?? "",
    publishedAt: str(raw.publishedAt),
    editedAt: str(raw.editedAt),
    version,
    canEdit: raw.canEdit === true,
  };
}

function readReviewableLine(value: unknown): ReviewableLine | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isReviewId(raw.orderId) || !isReviewId(raw.orderItemId)) return null;
  return {
    orderId: raw.orderId,
    orderNumber: str(raw.orderNumber) ?? "",
    orderItemId: raw.orderItemId,
    productId: str(raw.productId) ?? "",
    productName: str(raw.productName) ?? "",
    productSlug: str(raw.productSlug),
    variantLabel: str(raw.variantLabel),
    imageUrl: str(raw.imageUrl),
    fulfilledAt: str(raw.fulfilledAt),
  };
}

/** GET …/reviews: malformed rows are left out; a malformed body is null. */
export function readBuyerReviews(value: unknown): BuyerReviews | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.toReview) || !Array.isArray(raw.reviews)) return null;
  return {
    toReview: raw.toReview.map(readReviewableLine).filter((line): line is ReviewableLine => line !== null),
    reviews: raw.reviews.map(readBuyerReview).filter((review): review is BuyerReview => review !== null),
  };
}

// ---------------------------------------------------------------------------
// Where a form returns, and the outcome it returns with
// ---------------------------------------------------------------------------

export const REVIEW_STATUS_PARAM = "review";
/** The line a notice belongs to (an order item id: an opaque id, not PII). */
export const REVIEW_LINE_PARAM = "reviewLine";
/** With `exists`: the buyer's existing review to edit instead. */
export const REVIEW_REF_PARAM = "reviewRef";

export const REVIEW_NOTICE_FLAGS = [
  "published",
  "pending",
  "updated",
  "withdrawn",
  "rating",
  "invalid",
  "not_eligible",
  "exists",
  "disabled",
  "rate_limited",
  "unavailable",
  "changed",
  "not_editable",
  "signin",
  "receipt",
] as const;
export type ReviewNoticeFlag = (typeof REVIEW_NOTICE_FLAGS)[number];

const SUCCESS_FLAGS = new Set<ReviewNoticeFlag>(["published", "pending", "updated", "withdrawn"]);

export function isReviewNoticeFlag(value: unknown): value is ReviewNoticeFlag {
  return typeof value === "string" && (REVIEW_NOTICE_FLAGS as readonly string[]).includes(value);
}

export function isReviewSuccess(flag: ReviewNoticeFlag): boolean {
  return SUCCESS_FLAGS.has(flag);
}

export function reviewNoticeText(flag: ReviewNoticeFlag, copy: ReviewFormCopy): string {
  switch (flag) {
    case "published": return copy.reviewPublishedNoticeText;
    case "pending": return copy.reviewPendingNoticeText;
    case "updated": return copy.reviewUpdatedNoticeText;
    case "withdrawn": return copy.reviewWithdrawnNoticeText;
    case "rating": return copy.reviewRatingRequiredText;
    case "invalid": return copy.reviewInvalidText;
    case "not_eligible": return copy.reviewNotEligibleText;
    case "exists": return copy.reviewExistsText;
    case "disabled": return copy.reviewDisabledText;
    case "rate_limited": return copy.reviewRateLimitedText;
    case "unavailable": return copy.reviewUnavailableText;
    case "changed": return copy.reviewChangedText;
    case "not_editable": return copy.reviewNotEditableText;
    case "signin": return copy.reviewSignInText;
    case "receipt": return copy.reviewReceiptExpiredText;
  }
}

/** Which proof a review write uses: the account session, or one order's receipt cookie. */
export type ReviewAccess = { kind: "account" } | { kind: "receipt"; orderId: string };

/** What an API answer means for the buyer (status and error code only; never the body text). */
export function reviewFlagForApi(status: number, code: string | null, field: string | null, access: ReviewAccess): ReviewNoticeFlag {
  if (status === 400) return field === "rating" ? "rating" : "invalid";
  if (status === 401) return access.kind === "account" ? "signin" : "receipt";
  if (status === 403) return code === "REVIEWS_DISABLED" ? "disabled" : access.kind === "account" ? "signin" : "receipt";
  // A receipt 404 is a proof the API no longer accepts (the page rendered with it).
  if (status === 404) return access.kind === "receipt" ? "receipt" : "not_eligible";
  if (status === 409) {
    if (code === "REVIEW_EXISTS") return "exists";
    if (code === "REVIEW_NOT_ELIGIBLE") return "not_eligible";
    if (code === "REVIEW_NOT_EDITABLE") return "not_editable";
    return "changed";
  }
  if (status === 429) return "rate_limited";
  return "unavailable";
}

const RETURN_PATH = /^\/(?:account\/orders\/[A-Za-z0-9_-]{1,128}|account\/reviews|order-success)(?:\?[^#\s]*)?$/;

/** A same-origin page a review form may return to; anything else is refused. */
export function safeReviewReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300 || value.includes("//") || value.includes("\\")) return null;
  const path = value.split("#", 1)[0]!;
  return RETURN_PATH.test(path) ? path : null;
}

export function defaultReviewReturnPath(access: ReviewAccess): string {
  return access.kind === "account"
    ? "/account/reviews"
    : `/order-success?${new URLSearchParams({ orderId: access.orderId })}`;
}

/** The return page with the outcome: a flag, the line it belongs to and its anchor. Ids only. */
export function withReviewStatus(
  returnTo: string,
  flag: ReviewNoticeFlag,
  lineId: string | null,
  reviewRef: string | null = null,
): string {
  const url = new URL(returnTo, "https://storefront.invalid");
  for (const key of [REVIEW_STATUS_PARAM, REVIEW_LINE_PARAM, REVIEW_REF_PARAM]) url.searchParams.delete(key);
  url.searchParams.set(REVIEW_STATUS_PARAM, flag);
  if (lineId && isReviewId(lineId)) url.searchParams.set(REVIEW_LINE_PARAM, lineId);
  if (reviewRef && isReviewId(reviewRef)) url.searchParams.set(REVIEW_REF_PARAM, reviewRef);
  return `${url.pathname}${url.search}${lineId && isReviewId(lineId) ? `#${reviewAnchor(lineId)}` : ""}`;
}

export interface ReviewNotice {
  flag: ReviewNoticeFlag;
  lineId: string | null;
  reviewRef: string | null;
}

/** The outcome in a page's query string, when there is one. */
export function readReviewNotice(search: string): ReviewNotice | null {
  const params = new URLSearchParams(search);
  const flag = params.get(REVIEW_STATUS_PARAM);
  if (!isReviewNoticeFlag(flag)) return null;
  const lineId = params.get(REVIEW_LINE_PARAM);
  const reviewRef = params.get(REVIEW_REF_PARAM);
  return { flag, lineId: isReviewId(lineId) ? lineId : null, reviewRef: isReviewId(reviewRef) ? reviewRef : null };
}

/** The anchor of a line's review block (`#review-<orderItemId>`). */
export function reviewAnchor(orderItemId: string): string {
  return `review-${orderItemId}`;
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

export const REVIEW_FORM_ACTION = "/api/reviews/submit";

const STAR_PATH = "M12 1.6l3.1 6.6 7.2.9-5.3 5 1.4 7.1L12 17.7l-6.4 3.5L7 14.1l-5.3-5 7.2-.9z";

// Tailwind classes (these pages render the markup into places whose own
// stylesheet knows nothing about reviews).
const CLASS = {
  line: "mt-3 rounded-lg border border-border bg-background p-3 text-sm text-foreground",
  summary: "inline-flex min-h-11 cursor-pointer items-center gap-2 font-semibold text-primary hover:underline",
  form: "mt-2 space-y-4",
  label: "mb-1.5 block text-sm font-medium text-foreground",
  input: "w-full rounded-lg border border-border bg-background px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 sm:text-sm",
  help: "mt-1 text-xs leading-relaxed text-muted-foreground",
  submit: "inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-wait disabled:opacity-60",
  withdraw: "inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-background px-4 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:cursor-wait disabled:opacity-60",
  notice: "mb-3 rounded-lg border p-3 text-sm font-medium leading-relaxed",
  starsRow: "flex w-max flex-row-reverse justify-end gap-1",
  // Radios in reverse order: a checked or hovered star colours itself and
  // every star before it on screen (the siblings after it in the markup).
  starInput: "peer sr-only",
  starLabel: "peer inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-md text-muted-foreground/40 transition-colors hover:text-amber-500 peer-hover:text-amber-500 peer-checked:text-amber-500 [input:focus-visible+&]:ring-2 [input:focus-visible+&]:ring-primary",
  badge: "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
} as const;

/** Five stars filled to `rating` (decorative). */
export function reviewStarsMarkup(rating: number, size = "1rem"): string {
  const fill = Math.round(Math.min(Math.max(rating, 0), 5) * 2) * 10;
  return `<span class="sc-stars" style="--sc-fill:${fill}%;--sc-star:${escapeHtml(size)}" aria-hidden="true"></span>`;
}

function statusText(status: BuyerReviewStatus, copy: ReviewFormCopy): string {
  switch (status) {
    case "published": return copy.reviewStatusPublishedText;
    case "pending": return copy.reviewStatusPendingText;
    case "rejected": return copy.reviewStatusRejectedText;
    case "withdrawn": return copy.reviewStatusWithdrawnText;
  }
}

const STATUS_TONE: Record<BuyerReviewStatus, string> = {
  published: "bg-primary/10 text-primary",
  pending: "bg-muted text-foreground",
  rejected: "bg-destructive/10 text-destructive",
  withdrawn: "bg-muted text-muted-foreground",
};

export function reviewStatusBadgeMarkup(status: BuyerReviewStatus, copy: ReviewFormCopy): string {
  return `<span class="${CLASS.badge} ${STATUS_TONE[status]}" data-review-status="${status}">${escapeHtml(statusText(status, copy))}</span>`;
}

function field(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

function randomKey(): string {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export interface ReviewFormOptions {
  access: ReviewAccess;
  returnTo: string;
  copy: ReviewFormCopy;
  /** The order line reviewed (create) or the review's own line (edit). */
  orderItemId: string;
  /** Unique within the page: ids of labels and inputs. */
  idPrefix: string;
  /** Edit: the review being changed. */
  review?: BuyerReview | null;
}

/**
 * The review form: star radios (required, drawn with CSS so they work
 * without JavaScript), an optional title and text, and the name shown with
 * the review. Create posts `orderItemId` and a per-form `clientKey` (a
 * double submit returns the same review); edit posts `reviewId` and
 * `version`.
 */
export function reviewFormMarkup(options: ReviewFormOptions): string {
  const { access, returnTo, copy, orderItemId, idPrefix, review = null } = options;
  const id = (name: string) => `${idPrefix}-${name}`;
  const stars = [5, 4, 3, 2, 1].map((stars) => {
    const inputId = id(`star-${stars}`);
    const label = formatCheckoutLanguageText(copy.reviewStarOptionText, { stars });
    return `<input type="radio" id="${inputId}" name="rating" value="${stars}" required${review?.rating === stars ? " checked" : ""} class="${CLASS.starInput}">`
      + `<label for="${inputId}" class="${CLASS.starLabel}" title="${escapeHtml(label)}"><svg viewBox="-1 -1 26 26" class="h-8 w-8 fill-current" aria-hidden="true"><path d="${STAR_PATH}"/></svg><span class="sr-only">${escapeHtml(label)}</span></label>`;
  }).join("");
  const hidden = [
    field("intent", review ? "edit" : "submit"),
    field("returnTo", returnTo),
    field("orderItemId", orderItemId),
    access.kind === "receipt" ? field("orderId", access.orderId) : "",
    review ? field("reviewId", review.id) + field("version", String(review.version)) : field("clientKey", randomKey()),
  ].join("");
  return `<form method="post" action="${REVIEW_FORM_ACTION}" class="${CLASS.form}" data-review-form>`
    + hidden
    + `<fieldset><legend class="${CLASS.label}">${escapeHtml(copy.reviewRatingLabelText)}</legend>`
    + `<div class="${CLASS.starsRow}">${stars}</div></fieldset>`
    + `<div><label for="${id("title")}" class="${CLASS.label}">${escapeHtml(copy.reviewTitleLabelText)}</label>`
    + `<input id="${id("title")}" name="title" type="text" maxlength="${REVIEW_LIMITS.titleLength}" value="${escapeHtml(review?.title ?? "")}" class="${CLASS.input}" autocomplete="off"></div>`
    + `<div><label for="${id("body")}" class="${CLASS.label}">${escapeHtml(copy.reviewBodyLabelText)}</label>`
    + `<textarea id="${id("body")}" name="body" rows="4" maxlength="${REVIEW_LIMITS.bodyLength}" placeholder="${escapeHtml(copy.reviewBodyPlaceholderText)}" class="${CLASS.input} min-h-28">${escapeHtml(review?.body ?? "")}</textarea></div>`
    + `<div><label for="${id("name")}" class="${CLASS.label}">${escapeHtml(copy.reviewNameLabelText)}</label>`
    + `<input id="${id("name")}" name="displayName" type="text" maxlength="${REVIEW_LIMITS.displayNameLength}" value="${escapeHtml(review?.displayName ?? "")}" class="${CLASS.input}" autocomplete="off" aria-describedby="${id("name-help")}">`
    + `<p id="${id("name-help")}" class="${CLASS.help}">${escapeHtml(copy.reviewNameHelpText)}</p></div>`
    + `<p class="text-sm font-medium text-destructive" data-review-form-error role="alert" hidden></p>`
    + `<div><button type="submit" class="${CLASS.submit}">${escapeHtml(review ? copy.reviewSaveText : copy.reviewSubmitText)}</button></div>`
    + `</form>`;
}

/** Withdraw ("Remove review"): its own small form, so the edit button can't send it. */
export function reviewWithdrawFormMarkup(review: BuyerReview, options: Pick<ReviewFormOptions, "access" | "returnTo" | "copy">): string {
  const { access, returnTo, copy } = options;
  return `<form method="post" action="${REVIEW_FORM_ACTION}" class="mt-4 border-t border-border pt-4" data-review-form>`
    + field("intent", "withdraw")
    + field("returnTo", returnTo)
    + field("orderItemId", review.orderItemId)
    + field("reviewId", review.id)
    + field("version", String(review.version))
    + (access.kind === "receipt" ? field("orderId", access.orderId) : "")
    + `<p class="${CLASS.help} mb-2">${escapeHtml(copy.reviewWithdrawHelpText)}</p>`
    + `<p class="text-sm font-medium text-destructive" data-review-form-error role="alert" hidden></p>`
    + `<button type="submit" class="${CLASS.withdraw}">${escapeHtml(copy.reviewWithdrawText)}</button>`
    + `</form>`;
}

/** A notice (success or kind error) above a line's review block. */
export function reviewNoticeMarkup(
  notice: ReviewNotice,
  copy: ReviewFormCopy,
  options: { editHref?: (reviewId: string) => string | null } = {},
): string {
  const success = isReviewSuccess(notice.flag);
  const edit = notice.flag === "exists" && notice.reviewRef ? options.editHref?.(notice.reviewRef) ?? null : null;
  const tone = success ? "border-border bg-muted/40 text-foreground" : "border-destructive/30 bg-destructive/10 text-destructive";
  return `<p class="${CLASS.notice} ${tone}" role="${success ? "status" : "alert"}" data-review-notice="${notice.flag}">`
    + escapeHtml(reviewNoticeText(notice.flag, copy))
    + (edit ? ` <a href="${escapeHtml(edit)}" class="underline">${escapeHtml(copy.reviewEditExistingText)}</a>` : "")
    + `</p>`;
}

/** The buyer's own review in short: the stars, the status, the title and the text. */
export function buyerReviewSummaryMarkup(
  review: { rating: number; status: BuyerReviewStatus; title?: string | null; body?: string | null },
  copy: ReviewFormCopy,
): string {
  const rated = formatCheckoutLanguageText(copy.reviewsRatedText, { average: String(review.rating) });
  return `<p class="flex flex-wrap items-center gap-2">${reviewStarsMarkup(review.rating)}<span class="sr-only">${escapeHtml(rated)}</span>${reviewStatusBadgeMarkup(review.status, copy)}</p>`
    + (review.title ? `<p class="mt-1.5 font-semibold text-foreground [overflow-wrap:anywhere]">${escapeHtml(review.title)}</p>` : "")
    + (review.body ? `<p class="mt-1 whitespace-pre-line leading-relaxed text-foreground [overflow-wrap:anywhere]">${escapeHtml(review.body)}</p>` : "");
}

export interface LineReviewOptions {
  access: ReviewAccess;
  returnTo: string;
  copy: ReviewFormCopy;
  /** The page's outcome from its query string, shown on the line it belongs to. */
  notice?: ReviewNotice | null;
  /** The buyer's full review of this line, when the page read it (edit in place). */
  review?: BuyerReview | null;
  /** Where "Edit review" goes when the page can't edit in place (the account's Reviews page). */
  editHref?: (reviewId: string) => string | null;
  /** Start with the form open (the first line on the account's Reviews page). */
  open?: boolean;
}

/**
 * One order line's review block: the form for an eligible line with no
 * review yet, or the buyer's review with its status (and, when the page has
 * it, an "Edit review" disclosure with the edit and remove forms). Nothing
 * for a line that can't be reviewed and has no review.
 */
export function lineReviewMarkup(orderItemId: string, extra: LineReviewExtra | null, options: LineReviewOptions): string {
  const { access, returnTo, copy, notice = null, review = null, editHref, open: startOpen = false } = options;
  if (!extra || !isReviewId(orderItemId)) return "";
  const own = extra.review;
  const noticeHere = notice && notice.lineId === orderItemId ? notice : null;
  if (!own && !extra.eligible && !noticeHere) return "";
  const noticeMarkup = noticeHere ? reviewNoticeMarkup(noticeHere, copy, { editHref }) : "";
  const idPrefix = `review-${orderItemId}`;
  let body = "";
  if (!own && extra.eligible) {
    // Open after an error, so the buyer sees the form again at once.
    const open = startOpen || (noticeHere && !isReviewSuccess(noticeHere.flag)) ? " open" : "";
    body = `<details${open}><summary class="${CLASS.summary}">${reviewStarsMarkup(0, "1.125rem")}${escapeHtml(copy.reviewWriteTitleText)}</summary>`
      + reviewFormMarkup({ access, returnTo, copy, orderItemId, idPrefix })
      + `</details>`;
  } else if (own) {
    const full = review && review.id === own.id ? review : null;
    const editable = full ? full.canEdit : own.status === "pending" || own.status === "published";
    const link = !full && editable ? editHref?.(own.id) ?? null : null;
    body = `<p class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">${escapeHtml(copy.reviewYourReviewText)}</p>`
      + buyerReviewSummaryMarkup(full ?? own, copy)
      + (full && editable
        ? `<details class="mt-2"><summary class="${CLASS.summary}">${escapeHtml(copy.reviewEditText)}</summary>`
          + reviewFormMarkup({ access, returnTo, copy, orderItemId, idPrefix, review: full })
          + reviewWithdrawFormMarkup(full, { access, returnTo, copy })
          + `</details>`
        : link ? `<p class="mt-1"><a href="${escapeHtml(link)}" class="${CLASS.summary}">${escapeHtml(copy.reviewEditText)}</a></p>` : "");
  }
  return `<div class="${CLASS.line}" id="${reviewAnchor(orderItemId)}" data-review-line>${noticeMarkup}${body}</div>`;
}

// ---------------------------------------------------------------------------
// The account Reviews page
// ---------------------------------------------------------------------------

export interface AccountReviewPageOptions {
  copy: ReviewFormCopy;
  notice: ReviewNotice | null;
  /** The store's name for "Response from …"; null says "the store". */
  storeName: string | null;
  /** A product image URL at thumbnail width (the page's media helper). */
  imageUrl: (url: string | null) => string | null;
  formatDate: (iso: string | null) => string;
}

const RETURN_TO_ACCOUNT_REVIEWS = "/account/reviews";

function orderLabel(copy: ReviewFormCopy, orderNumber: string, orderId: string): string {
  const number = orderNumber ? (orderNumber.startsWith("#") ? orderNumber : `#${orderNumber}`) : `#${orderId}`;
  return formatCheckoutLanguageText(copy.reviewOrderText, { order: number });
}

function productHeader(
  product: { name: string; slug: string | null; variantLabel: string | null; image?: string | null },
  meta: string,
): string {
  const name = escapeHtml(product.name);
  const title = product.slug
    ? `<a href="/products/${encodeURIComponent(product.slug)}" class="font-semibold text-foreground hover:underline">${name}</a>`
    : `<span class="font-semibold text-foreground">${name}</span>`;
  const image = product.image === undefined
    ? ""
    : product.image
    ? `<img src="${escapeHtml(product.image)}" alt="" width="64" height="64" loading="lazy" decoding="async" class="h-16 w-16 shrink-0 rounded-md border border-border bg-muted object-contain">`
    : `<span class="h-16 w-16 shrink-0 rounded-md border border-border bg-muted" aria-hidden="true"></span>`;
  return `<div class="flex items-start gap-3">${image}<div class="min-w-0 [overflow-wrap:anywhere]"><p>${title}</p>`
    + (product.variantLabel ? `<p class="text-sm text-muted-foreground">${escapeHtml(product.variantLabel)}</p>` : "")
    + `<p class="text-xs text-muted-foreground">${escapeHtml(meta)}</p></div></div>`;
}

/** "To review": each delivered line with its form (the first open, so one tap starts). */
export function toReviewListMarkup(lines: readonly ReviewableLine[], options: AccountReviewPageOptions): string {
  const { copy, notice } = options;
  return lines.map((line, index) => {
    const delivered = options.formatDate(line.fulfilledAt);
    const meta = [orderLabel(copy, line.orderNumber, line.orderId), delivered ? formatCheckoutLanguageText(copy.reviewDeliveredOnText, { date: delivered }) : ""]
      .filter(Boolean).join(" · ");
    const form = lineReviewMarkup(line.orderItemId, { eligible: true, review: null }, {
      access: { kind: "account" },
      returnTo: RETURN_TO_ACCOUNT_REVIEWS,
      copy,
      notice,
      open: index === 0,
      editHref: (reviewId) => `/account/reviews#written-${reviewId}`,
    });
    return `<li class="rounded-xl border border-border bg-card p-4">`
      + productHeader({ name: line.productName, slug: line.productSlug, variantLabel: line.variantLabel, image: options.imageUrl(line.imageUrl) }, meta)
      + form
      + `</li>`;
  }).join("");
}

/** "Reviews you wrote": each with its status, the store's reply, and edit or remove while it can change. */
export function writtenReviewListMarkup(reviews: readonly BuyerReview[], options: AccountReviewPageOptions): string {
  const { copy, notice, storeName } = options;
  return reviews.map((review) => {
    const noticeHere = notice && notice.lineId === review.orderItemId ? reviewNoticeMarkup(notice, copy) : "";
    const dated = options.formatDate(review.publishedAt ?? review.createdAt);
    const meta = [dated, review.editedAt ? copy.reviewsEditedText : ""]
      .filter(Boolean).join(" · ");
    const replyTitle = storeName
      ? formatCheckoutLanguageText(copy.reviewsReplyText, { store: storeName })
      : copy.reviewsReplyFallbackText;
    const reply = review.reply
      ? `<div class="mt-3 rounded-r-lg border-l-4 border-primary bg-muted/50 px-3 py-2"><p class="text-xs font-semibold text-foreground">${escapeHtml(replyTitle)}</p>`
        + `<p class="mt-1 whitespace-pre-line text-sm text-foreground [overflow-wrap:anywhere]">${escapeHtml(review.reply.body)}</p></div>`
      : "";
    const edit = review.canEdit
      ? `<details class="mt-2"${noticeHere && !isReviewSuccess(notice!.flag) ? " open" : ""}><summary class="${CLASS.summary}">${escapeHtml(copy.reviewEditText)}</summary>`
        + reviewFormMarkup({ access: { kind: "account" }, returnTo: RETURN_TO_ACCOUNT_REVIEWS, copy, orderItemId: review.orderItemId, idPrefix: `written-${review.id}`, review })
        + reviewWithdrawFormMarkup(review, { access: { kind: "account" }, returnTo: RETURN_TO_ACCOUNT_REVIEWS, copy })
        + `</details>`
      : "";
    return `<li class="rounded-xl border border-border bg-card p-4" id="${reviewAnchor(review.orderItemId)}">`
      + `<span id="written-${escapeHtml(review.id)}" class="block scroll-mt-24" aria-hidden="true"></span>`
      + noticeHere
      + productHeader({ name: review.productName, slug: review.productSlug, variantLabel: review.variantLabel }, meta)
      + `<div class="mt-3 text-sm">${buyerReviewSummaryMarkup(review, copy)}</div>`
      + reply
      + edit
      + `</li>`;
  }).join("");
}
