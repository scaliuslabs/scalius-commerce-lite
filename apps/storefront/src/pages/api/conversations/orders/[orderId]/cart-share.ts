import type { APIRoute } from "astro";
import { orderTarget } from "@/lib/account-inbox-server";
import { proxyConversationCartShare } from "@/lib/conversation-cart-share-server";

export const prerender = false;
const handle: APIRoute = ({ request, params, url }) => proxyConversationCartShare(request, orderTarget(params.orderId, url.searchParams.get("access")));
export const GET = handle;
export const PUT = handle;
export const DELETE = handle;
