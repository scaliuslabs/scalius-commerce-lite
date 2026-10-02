// POST /api/newsletter/subscribe: the newsletter signup form (homepage
// section, newsletter-grey footer, /newsletter). The phone, e-mail and boxes
// arrive in the form body only and go on to POST /api/v1/marketing/subscribe
// with the consent text the form showed. Without JavaScript the answer is a
// 303 to /newsletter?status=<outcome>; the form's script asks for JSON and
// shows the outcome in place. A filled honeypot gets the success answer and
// calls nothing. Nothing is logged or put in a URL but the outcome flag.
import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import {
  isCrossOriginPost,
  newsletterForbidden,
  readNewsletterForm,
  readNewsletterSignup,
  respondToNewsletterPost,
  subscribeToNewsletter,
} from "@/lib/newsletter-server";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request) || isCrossOriginPost(request)) {
    return newsletterForbidden(request);
  }
  const form = await readNewsletterForm(request);
  if (!form) return respondToNewsletterPost(request, { status: "invalid" });
  const outcome = await subscribeToNewsletter(request, readNewsletterSignup(form));
  return respondToNewsletterPost(request, outcome);
};
