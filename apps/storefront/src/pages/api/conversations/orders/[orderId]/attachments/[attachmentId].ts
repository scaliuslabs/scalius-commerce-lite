// One private image of a guest order's thread. The receipt proof comes from
// the order's httpOnly cookie and reaches the API only as a header; the URL
// carries the order and attachment ids alone. Never cached, never sniffed.
// (Signed-in owners load images through /api/conversations/<cnv_id>/….)
import type { APIRoute } from "astro";
import { orderTarget, proxyConversationAttachment } from "@/lib/account-inbox-server";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const target = orderTarget(params.orderId, "receipt");
  return proxyConversationAttachment(
    request,
    target ?? { kind: "order", orderId: "", access: "receipt" },
    target ? params.attachmentId ?? "" : "",
  );
};
