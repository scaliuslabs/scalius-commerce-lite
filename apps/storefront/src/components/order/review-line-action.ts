// B2 (reviews): one order line's review block, as markup. The receipt renders
// it server-side (ReviewLineAction.astro, which also reads the buyer's full
// reviews so they can be edited in place); the browser-rendered account order
// page appends it under the line through `lineExtrasMarkup`, and "Edit
// review" there leads to the account's Reviews page. The form is a plain
// `method=post` (ids, a same-origin return path, and on a receipt the order
// id); nothing when the line can't be reviewed and has no review.
import type { LineExtrasContext, OrderLine } from "@/lib/order-line-extras";
import {
  lineReviewMarkup,
  pickReviewFormCopy,
  readLineReviewExtra,
  readReviewNotice,
  safeReviewReturnPath,
  type BuyerReview,
  type LineReviewExtra,
  type ReviewAccess,
  type ReviewFormCopy,
  type ReviewNotice,
} from "@/lib/account-reviews";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import { setupReviewForms } from "./review-form-client";

/** `extras.review` from the API: whether the line can be reviewed, and the buyer's review of it. */
export type ReviewLineExtra = LineReviewExtra;

export interface ReviewLineActionOptions {
  copy?: ReviewFormCopy;
  /** The page the forms return to; defaults to the page for this access. */
  returnTo?: string;
  /** The outcome a form came back with (read from the address bar in the browser). */
  notice?: ReviewNotice | null;
  /** The buyer's full reviews of this order, when the page read them (edit in place). */
  reviews?: readonly BuyerReview[] | null;
}

function browserLocation(): Location | null {
  return (globalThis as { location?: Location }).location ?? null;
}

function defaultReturnTo(context: LineExtrasContext): string {
  const location = browserLocation();
  const here = location ? safeReviewReturnPath(`${location.pathname}${location.search}`) : null;
  if (here) return here;
  return context.access === "account"
    ? `/account/orders/${encodeURIComponent(context.orderId)}`
    : `/order-success?${new URLSearchParams({ orderId: context.orderId })}`;
}

export function reviewLineActionMarkup(line: OrderLine, context: LineExtrasContext, options: ReviewLineActionOptions = {}): string {
  const extra = readLineReviewExtra(line.extras?.review);
  if (!extra) return "";
  const access: ReviewAccess = context.access === "receipt" ? { kind: "receipt", orderId: context.orderId } : { kind: "account" };
  const location = browserLocation();
  // In the browser (the account order page) the forms submit through fetch.
  if (typeof document !== "undefined") setupReviewForms();
  return lineReviewMarkup(line.id, extra, {
    access,
    returnTo: options.returnTo ?? defaultReturnTo(context),
    copy: options.copy ?? pickReviewFormCopy(null, ENGLISH_CHECKOUT_LANGUAGE_DATA),
    notice: options.notice === undefined ? (location ? readReviewNotice(location.search) : null) : options.notice,
    review: options.reviews?.find((review) => review.orderItemId === line.id) ?? null,
    editHref: access.kind === "account" ? (reviewId) => `/account/reviews#written-${reviewId}` : undefined,
  });
}
