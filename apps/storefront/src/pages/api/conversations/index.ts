import type { APIRoute } from "astro";
import { conversationJson, readInbox, wantsJson } from "@/lib/account-inbox-server";
import { renderInboxItems } from "@/lib/account-inbox";
import { seedRuntimeStoreLanguage } from "@/lib/api/runtime";
export const prerender = false;
/** The latest inbox window; private and read-only, including unread flags. */
export const GET: APIRoute = async ({ request }) => {
  const site = request.headers.get("Sec-Fetch-Site");
  if (!wantsJson(request) || (site && site !== "same-origin" && site !== "none")) return conversationJson({ success: false }, 403);
  seedRuntimeStoreLanguage(new URL(request.url).searchParams.get("lang"));
  const result = await readInbox(request);
  if (!result.ok) {
    const response = conversationJson({ success: false }, result.retryAfter ? 429 : result.reason === "signed_out" ? 401 : result.reason === "no_access" ? 403 : 503);
    if (result.retryAfter) response.headers.set("Retry-After", result.retryAfter);
    return response;
  }
  return conversationJson({ success: true, data: { html: renderInboxItems(result.data.items), nextCursor: result.data.nextCursor } }, 200);
};
