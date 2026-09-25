// "Message the store": starts a store conversation for a verified account.
// A plain form post (works without JavaScript) is answered with a redirect to
// the new thread; the subject and message travel only in the POST body.
import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import {
  crossOriginRefusal,
  readConversationForm,
  respondToConversationPost,
  startStoreConversation,
} from "@/lib/account-inbox-server";

export const prerender = false;

const INBOX = "/account/inbox";

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) return crossOriginRefusal(request);
  const read = await readConversationForm(request);
  if (!read.ok) return respondToConversationPost(request, { ok: false, flag: read.flag }, { returnTo: INBOX });
  const result = await startStoreConversation(request, read.form);
  return respondToConversationPost(request, result, {
    returnTo: INBOX,
    redirectOnSuccess: result.ok ? `${INBOX}/${encodeURIComponent(result.thread.id)}` : undefined,
  });
};
