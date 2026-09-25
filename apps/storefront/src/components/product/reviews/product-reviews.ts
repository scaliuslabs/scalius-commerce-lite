// The product page's reviews module in the browser: "Show more", the sort
// and the star filter read pages through /api/reviews/<productId> and update
// the list in place. Every control is a link to /products/<slug>/reviews
// first, so a failed read (or no JavaScript) still gets the buyer there.
// Only ids, a sort, a star and an opaque cursor go into a URL; review text
// never does, and nothing here reaches analytics.
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import {
  REVIEW_PAGE_SIZE,
  REVIEW_SORTS,
  productReviewsPageHref,
  productReviewsProxyHref,
  publicReviewListMarkup,
  readProductReviews,
  type ReviewCopy,
  type ReviewListView,
  type ReviewSort,
} from "./review-format";

type ScriptCopy = Pick<
  ReviewCopy,
  | "reviewsRatedText"
  | "reviewsVerifiedText"
  | "reviewsEditedText"
  | "reviewsReplyText"
  | "reviewsReplyFallbackText"
  | "reviewsFilteredText"
  | "reviewsFilterEmptyText"
  | "reviewsLoadFailedText"
>;

function readCopy(root: HTMLElement): ScriptCopy | null {
  try {
    const copy = JSON.parse(root.dataset.reviewCopy ?? "") as Partial<ScriptCopy>;
    return typeof copy.reviewsRatedText === "string" ? copy as ScriptCopy : null;
  } catch {
    return null;
  }
}

export function setupProductReviews(): void {
  const root = document.querySelector<HTMLElement>("[data-product-reviews]");
  if (!root || root.dataset.reviewsBound === "true") return;
  const copy = readCopy(root);
  const productId = root.dataset.productId ?? "";
  const slug = root.dataset.productSlug ?? "";
  const list = root.querySelector<HTMLElement>("[data-review-list]");
  const status = root.querySelector<HTMLElement>("[data-review-status]");
  const more = root.querySelector<HTMLAnchorElement>("[data-review-more]");
  const filter = root.querySelector<HTMLElement>("[data-review-filter]");
  const filterLabel = root.querySelector<HTMLElement>("[data-review-filter-label]");
  if (!copy || !productId || !list || !status) return;
  root.dataset.reviewsBound = "true";

  const render = {
    copy,
    language: root.dataset.reviewLanguage || "en",
    storeName: root.dataset.reviewStore || null,
  };
  let view: ReviewListView = { sort: "recent", rating: null };
  let cursor = root.dataset.reviewCursor || null;
  let busy = false;

  const showStatus = (message: string) => {
    status.textContent = message;
    status.hidden = !message;
  };
  const syncControls = () => {
    root.querySelectorAll<HTMLAnchorElement>("[data-review-sort]").forEach((link) => {
      if (link.dataset.reviewSort === view.sort) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
    root.querySelectorAll<HTMLElement>("[data-review-rating]").forEach((bar) => {
      bar.classList.toggle("is-selected", Number(bar.dataset.reviewRating) === view.rating);
    });
    if (filter && filterLabel) {
      filter.hidden = view.rating === null;
      filterLabel.textContent = view.rating === null
        ? ""
        : formatCheckoutLanguageText(copy.reviewsFilteredText, { stars: view.rating });
    }
    if (more) {
      more.hidden = !cursor;
      if (cursor) more.href = productReviewsPageHref(slug, { ...view, after: cursor });
    }
  };

  /** Reads one page; `append` keeps the list (Show more), else it replaces it. */
  const load = async (next: ReviewListView, append: boolean, fallbackHref: string) => {
    if (busy) return;
    busy = true;
    root.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(productReviewsProxyHref(productId, {
        ...next,
        cursor: append ? cursor : null,
        limit: REVIEW_PAGE_SIZE,
      }), { headers: { Accept: "application/json" } });
      const body = response.ok ? await response.json() as { data?: unknown } : null;
      const page = readProductReviews(body?.data);
      if (!page) throw new Error("unreadable");
      view = next;
      cursor = page.nextCursor;
      const markup = publicReviewListMarkup(page.items, render);
      if (append) list.insertAdjacentHTML("beforeend", markup);
      else list.innerHTML = markup;
      showStatus(!append && page.items.length === 0 && next.rating !== null
        ? formatCheckoutLanguageText(copy.reviewsFilterEmptyText, { stars: next.rating })
        : "");
      syncControls();
    } catch {
      // The link still works: offer it rather than a dead button.
      showStatus(copy.reviewsLoadFailedText);
      if (!append) window.location.href = fallbackHref;
    } finally {
      busy = false;
      root.removeAttribute("aria-busy");
    }
  };

  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    if (!target || !root.contains(target)) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (target.hasAttribute("data-review-more")) {
      if (!cursor) return;
      event.preventDefault();
      void load(view, true, target.href);
      return;
    }
    const sort = target.dataset.reviewSort;
    if (sort && (REVIEW_SORTS as readonly string[]).includes(sort)) {
      event.preventDefault();
      void load({ ...view, sort: sort as ReviewSort }, false, target.href);
      return;
    }
    const rating = Number(target.dataset.reviewRating);
    if (Number.isInteger(rating) && rating >= 1 && rating <= 5) {
      event.preventDefault();
      void load({ ...view, rating: view.rating === rating ? null : rating }, false, target.href);
      return;
    }
    if (target.hasAttribute("data-review-filter-clear")) {
      event.preventDefault();
      void load({ ...view, rating: null }, false, target.href);
    }
  });
  syncControls();
}
