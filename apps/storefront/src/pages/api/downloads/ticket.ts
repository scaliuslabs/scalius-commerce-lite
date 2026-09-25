// The Download button (a plain form post, so it works without JavaScript):
// counts one download with this browser's proof and 303s to the short-lived
// stream link, or 303s back to the page with only an outcome flag
// (`?download=limit|revoked|expired|…`) and the file's anchor. Fields: ids and
// a same-origin return path; `orderId` is present on receipt pages only.
import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { PRIVATE_HEADERS, handleDownloadTicketPost, privateRedirect } from "@/lib/account-downloads-server";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", ...PRIVATE_HEADERS } });
  }
  return handleDownloadTicketPost(request);
};

export const GET: APIRoute = () => privateRedirect("/account/downloads");
