// The review form's POST (Wave B §2.4): submit, edit or withdraw a review
// with this browser's proof (the account session, or on a receipt the
// order's receipt cookie), then 303 back to the page with only an outcome
// flag, the line id and its anchor. With JavaScript the form asks for JSON
// instead, so an error keeps what the buyer typed. Review text arrives in the
// body only; nothing here logs it.
import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { getCheckoutLanguagePreset } from "@scalius/shared/checkout-language";
import { getActiveCheckoutLanguage, getLayoutData } from "@/lib/api";
import { pickReviewFormCopy, type ReviewAccess } from "@/lib/account-reviews";
import { PRIVATE_HEADERS, handleReviewFormPost, privateRedirect } from "@/lib/account-reviews-server";

export const prerender = false;

/** The copy of the page the form came from: the receipt's checkout language, or the store's language on account pages. */
async function copyFor(access: ReviewAccess) {
  if (access.kind === "receipt") {
    const language = await getActiveCheckoutLanguage().catch(() => null);
    return pickReviewFormCopy(language?.languageData, getCheckoutLanguagePreset(language?.code));
  }
  const layout = await getLayoutData().catch(() => null);
  return pickReviewFormCopy(null, getCheckoutLanguagePreset(layout?.storefrontCopy?.languageCode));
}

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", ...PRIVATE_HEADERS } });
  }
  return handleReviewFormPost(request, copyFor);
};

export const GET: APIRoute = () => privateRedirect("/account/reviews");
