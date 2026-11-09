import { setupProductReviews } from "./product-reviews";
import { setupReviewCta } from "./review-cta";

/** Binds the reviews section: its sort, filter and Show more, and the buyer's review call to action. */
export function bootProductReviews(): void {
  setupProductReviews();
  setupReviewCta();
}
