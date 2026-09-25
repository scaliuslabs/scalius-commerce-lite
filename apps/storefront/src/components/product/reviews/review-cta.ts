// "Write a review" on the product page. The page HTML is shared and publicly
// cached, so it carries one neutral link to the account's Reviews page (the
// no-JavaScript path). After hydration this asks
// /api/reviews/<productId>/mine (same-origin, the session cookie, no-store)
// what this browser's account may do, and shows:
//   signed out     → "Sign in to review" (opens the sign-in dialog here, then asks again)
//   eligible       → "Write a review" and an inline form (the API chose the order line)
//   reviewed       → the buyer's review marked Published or Pending, and "Edit your review"
//   not a buyer    → "Only verified buyers can review this product."
// The form posts to /api/reviews/submit as JSON; after a save the buyer's
// review shows at once, and the note says other shoppers see it within about
// 15 minutes (the coalesced public cache refresh). Review text only travels in
// a POST body.
import {
  buyerReviewSummaryMarkup,
  readProductReviewState,
  reviewFormMarkup,
  type BuyerReview,
  type ProductReviewState,
  type ReviewFormCopy,
} from "@/lib/account-reviews";
import { escapeHtml } from "@scalius/shared/html-escape";

type CtaCopy = ReviewFormCopy & {
  reviewsSignInToReviewText: string;
  reviewsVerifiedOnlyText: string;
  reviewsVisibleSoonText: string;
  reviewsWriteCtaText: string;
};

/** The personal answer, never from a cache. */
export async function fetchProductReviewState(productId: string, fetcher: typeof fetch = fetch): Promise<ProductReviewState> {
  try {
    const response = await fetcher(`/api/reviews/${encodeURIComponent(productId)}/mine`, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
    return response.ok ? readProductReviewState(await response.json()) : { state: "unavailable" };
  } catch {
    return { state: "unavailable" };
  }
}

function readCopy(root: HTMLElement): CtaCopy | null {
  try {
    const copy = JSON.parse(root.dataset.reviewFormCopy ?? "") as Partial<CtaCopy>;
    return typeof copy.reviewSubmitText === "string" ? copy as CtaCopy : null;
  } catch {
    return null;
  }
}

export function setupReviewCta(): void {
  const section = document.querySelector<HTMLElement>("section#reviews[data-product-id]");
  const root = section?.querySelector<HTMLElement>("[data-review-cta]");
  const link = root?.querySelector<HTMLAnchorElement>("[data-review-cta-link]");
  const note = root?.querySelector<HTMLElement>("[data-review-cta-note]");
  const panel = section?.querySelector<HTMLElement>("[data-review-cta-panel]");
  const productId = section?.dataset.productId ?? "";
  if (!section || !root || !link || !note || !panel || !productId || root.dataset.ctaBound === "true") return;
  const copy = readCopy(root);
  if (!copy) return;
  root.dataset.ctaBound = "true";

  let state: ProductReviewState = { state: "unavailable" };
  let formOpen = false;

  const ownReview = (review: BuyerReview) =>
    `<p class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">${escapeHtml(copy.reviewYourReviewText)}</p>`
    + `<div class="text-sm">${buyerReviewSummaryMarkup(review, copy)}</div>`
    + (review.status === "published" || review.status === "pending"
      ? `<p class="mt-2 text-xs text-muted-foreground">${escapeHtml(review.status === "pending" ? copy.reviewPendingNoticeText : copy.reviewsVisibleSoonText)}</p>`
      : "");

  const form = (): string => {
    if (state.state === "eligible") {
      return reviewFormMarkup({ access: { kind: "account" }, returnTo: "/account/reviews", copy, orderItemId: state.orderItemId, idPrefix: "pdp-review" });
    }
    if (state.state === "reviewed") {
      return reviewFormMarkup({ access: { kind: "account" }, returnTo: "/account/reviews", copy, orderItemId: state.review.orderItemId, idPrefix: "pdp-review", review: state.review });
    }
    return "";
  };

  const render = () => {
    const reviewed = state.state === "reviewed" ? state.review : null;
    const canWrite = state.state === "eligible" || Boolean(reviewed?.canEdit);
    link.hidden = state.state === "disabled" || state.state === "ineligible" || (Boolean(reviewed) && !canWrite);
    link.textContent = state.state === "signed_out"
      ? copy.reviewsSignInToReviewText
      : reviewed ? copy.reviewEditExistingText : copy.reviewsWriteCtaText;
    link.setAttribute("aria-expanded", String(formOpen));
    if (canWrite) link.setAttribute("role", "button");
    else link.removeAttribute("role");
    note.hidden = state.state !== "ineligible";
    note.textContent = state.state === "ineligible" ? copy.reviewsVerifiedOnlyText : "";

    const body = (reviewed && !formOpen ? ownReview(reviewed) : "") + (formOpen && canWrite ? form() : "");
    panel.innerHTML = body;
    panel.hidden = !body;
    if (formOpen && state.state === "eligible") {
      const name = panel.querySelector<HTMLInputElement>("input[name=displayName]");
      if (name && !name.value) name.value = state.displayName;
    }
  };

  const refresh = async () => {
    state = await fetchProductReviewState(productId);
    formOpen = false;
    render();
  };

  link.addEventListener("click", (event) => {
    if (state.state === "unavailable") return; // the account's Reviews page
    event.preventDefault();
    if (state.state === "signed_out") {
      window.dispatchEvent(new CustomEvent("open-auth-modal"));
      return;
    }
    formOpen = !formOpen;
    render();
    if (formOpen) panel.querySelector<HTMLInputElement>("input[name=rating]:checked, input[name=rating]")?.focus();
  });

  panel.addEventListener("submit", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLFormElement)) return;
    event.preventDefault();
    const button = target.querySelector<HTMLButtonElement>("button[type=submit]");
    const error = target.querySelector<HTMLElement>("[data-review-form-error]");
    if (button) button.disabled = true;
    void fetch(target.action, {
      method: "POST",
      body: new URLSearchParams(new FormData(target) as unknown as Record<string, string>),
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    }).then(async (response) => {
      const answer = await response.json() as { ok?: unknown; message?: unknown };
      if (answer.ok === true) {
        // The review itself now shows, marked Published or Pending, with when others see it.
        await refresh();
        return;
      }
      if (typeof answer.message !== "string") throw new Error("unreadable");
      if (error) {
        error.textContent = answer.message;
        error.hidden = false;
      }
      if (button) button.disabled = false;
    }).catch(() => {
      // The plain post still saves it (and lands on the account's Reviews page).
      target.submit();
    });
  });

  // Signing in from "Sign in to review" asks again, right here.
  window.addEventListener("customer-login", () => void refresh());
  window.addEventListener("customer-logout", () => void refresh());
  void refresh();
}
