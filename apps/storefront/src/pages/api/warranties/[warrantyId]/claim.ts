// The warranty claim form (WarrantyClaimForm.astro): stages the photos, opens
// the claim and its thread, then sends the buyer to that thread: the account
// Inbox (`?access=account`, session cookie) or, for a guest (`?orderId=`, the
// order's receipt proof read from its httpOnly cookie and sent to the API only
// as a header), the claim page. With JavaScript the answer is JSON the
// conversation form follows; without it, a 303. A refused post returns to the
// form's page with that form open and the outcome flag (ids and a flag only).
import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { getCheckoutLanguagePreset } from "@scalius/shared/checkout-language";
import { getActiveCheckoutLanguage } from "@/lib/api";
import { isOrderId, withConversationStatus } from "@/lib/account-inbox";
import {
  conversationJson,
  conversationRedirect,
  crossOriginRefusal,
  formReturnPath,
  readConversationForm,
  wantsJson,
} from "@/lib/account-inbox-server";
import {
  isWarrantyId,
  pickWarrantyCopy,
  warrantyClaimFlagText,
  warrantyClaimThreadHref,
  withWarrantyClaimStatus,
  type WarrantyAccess,
  type WarrantyClaimFlag,
} from "@/lib/account-warranties";
import { openWarrantyClaimFromForm } from "@/lib/account-warranties-server";

export const prerender = false;

const JSON_STATUS: Record<WarrantyClaimFlag, number> = {
  invalid: 400,
  photo: 400,
  signin: 401,
  missing: 404,
  inactive: 409,
  exists: 409,
  rate: 429,
  unavailable: 503,
};

export const POST: APIRoute = async ({ request, params, url }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) return crossOriginRefusal(request);
  const warrantyId = isWarrantyId(params.warrantyId) ? params.warrantyId : null;
  const orderId = url.searchParams.get("orderId");
  const access: WarrantyAccess | null = url.searchParams.get("access") === "account"
    ? { kind: "account" }
    : isOrderId(orderId) ? { kind: "receipt", orderId } : null;

  const read = await readConversationForm(request);
  const fallback = access?.kind === "receipt"
    ? `/order-success?${new URLSearchParams({ orderId: access.orderId })}`
    : "/account/warranties";
  const returnTo = formReturnPath(read.ok ? read.form : null, fallback);

  const result = !warrantyId || !access
    ? { ok: false as const, flag: "missing" as const }
    : !read.ok
      ? { ok: false as const, flag: read.flag === "image" ? "photo" as const : "invalid" as const }
      : await openWarrantyClaimFromForm(request, warrantyId, access, read.form);

  if (result.ok && access) {
    const thread = warrantyClaimThreadHref({ id: result.claimId, conversationId: result.conversationId, status: "open" }, access);
    const destination = withConversationStatus(thread, "started");
    return wantsJson(request)
      ? conversationJson({ success: true, data: { conversationId: result.conversationId, redirect: destination } }, 201)
      : conversationRedirect(destination);
  }

  const flag = result.ok ? "unavailable" : result.flag;
  if (wantsJson(request)) {
    const language = await getActiveCheckoutLanguage().catch(() => null);
    const copy = pickWarrantyCopy(language?.languageData, getCheckoutLanguagePreset(language?.code));
    return conversationJson({ success: false, error: { code: flag, message: warrantyClaimFlagText(flag, copy) } }, JSON_STATUS[flag]);
  }
  return conversationRedirect(warrantyId ? withWarrantyClaimStatus(returnTo, warrantyId, flag) : returnTo);
};
