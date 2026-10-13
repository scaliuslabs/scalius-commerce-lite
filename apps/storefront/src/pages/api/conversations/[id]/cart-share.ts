import type { APIRoute } from "astro";
import { isConversationId } from "@/lib/account-inbox";
import { proxyConversationCartShare } from "@/lib/conversation-cart-share-server";

export const prerender = false;
const handle: APIRoute = ({ request, params }) => proxyConversationCartShare(request,
  isConversationId(params.id) ? { kind: "thread", conversationId: params.id } : null);
export const GET = handle;
export const PUT = handle;
export const DELETE = handle;
