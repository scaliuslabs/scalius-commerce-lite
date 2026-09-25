// One private image of a guest's warranty claim thread. The receipt proof comes
// from the order's httpOnly cookie and reaches the API only as a header; the
// URL carries ids alone. Never cached, never sniffed.
import type { APIRoute } from "astro";
import { isOrderId } from "@/lib/account-inbox";
import { proxyConversationAttachment } from "@/lib/account-inbox-server";
import { isWarrantyClaimId } from "@/lib/account-warranties";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const { orderId, claimId } = params;
  const valid = isOrderId(orderId) && isWarrantyClaimId(claimId);
  return proxyConversationAttachment(
    request,
    { kind: "claim", orderId: valid ? orderId : "", claimId: valid ? claimId : "" },
    valid ? params.attachmentId ?? "" : "",
  );
};
