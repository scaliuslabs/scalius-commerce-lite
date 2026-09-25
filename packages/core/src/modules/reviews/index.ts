// Reviews domain: verified-purchase reviews of delivered order lines,
// moderation, merchant replies, review requests and the coalesced cache-bump
// check (Wave B design §2). The public review reads (product page and the
// public list) live in `catalog`, which reads the same tables through its own
// selects so the catalogue never depends on this domain.
export * from "./browser";
export type { LineExtrasInput } from "../../utils/line-extras";
export type { ReviewBuyer } from "./shared";
export {
  countReviewableLinesForCustomer,
  countWrittenReviewsForCustomer,
  listLineReviewStates,
  listReviewableLines,
  REVIEWABLE_LINES_MAX,
  type ReviewableLine,
} from "./lines";
export {
  editReview,
  getBuyerReview,
  listBuyerReviews,
  readBuyerProductReviewState,
  submitReview,
  withdrawReview,
  type BuyerProductReviewState,
  type BuyerReview,
  type EditReviewInput,
  type ReviewWriteOptions,
  type ReviewWriteResult,
  type SubmitReviewInput,
} from "./buyer";
export {
  getAdminReview,
  getAdminReviewSummary,
  getReviewSettingsForAdmin,
  listAdminReviews,
  moderateReviews,
  openReviewThread,
  saveReviewSettings,
  setReviewReply,
  type AdminReview,
  type AdminReviewFilters,
  type AdminReviewPage,
  type AdminReviewSummary,
  type ModerateReviewsInput,
  type ModerateReviewsResult,
  type ProductReviewStatsSummary,
  type ReviewSettingsView,
} from "./staff";
export {
  reviewRequestSendCheck,
  reviewsChangedSince,
  sweepReviewRequests,
  type ReviewRequestContent,
} from "./requests";
