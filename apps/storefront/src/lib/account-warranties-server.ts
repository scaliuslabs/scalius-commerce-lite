// Server side of buyer warranties (Wave B §5.2): the account's warranties read
// and the claim form post. A claim is opened in one API call after its photos
// are staged against the form's key (the conversation pipeline: re-encoded,
// private, attached by id). Credentials: the account session as `cs_tok`, or a
// guest order's receipt proof from its httpOnly cookie as the X-Receipt-Token
// header; neither, nor the claim text, enters a URL or a log.
import { normalizeConversationBody } from "@scalius/shared/conversation";
import {
  checkAttachmentFiles,
  isClientMessageKey,
  isConversationAttachmentId,
  isConversationId,
} from "@/lib/account-inbox";
import { buyerProofHeaders, callApi, envelopeData, type ReadResult } from "@/lib/account-inbox-server";
import {
  isWarrantyClaimId,
  readBuyerWarranties,
  type BuyerWarranty,
  type WarrantyAccess,
  type WarrantyClaimFlag,
} from "@/lib/account-warranties";

const READ_TIMEOUT_MS = 6_000;
const WRITE_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 20_000;
/** The API's claim form key: [A-Za-z0-9_-]{8,100}. */
const CLAIM_KEY_MAX = 100;

export async function readAccountWarranties(request: Request): Promise<ReadResult<BuyerWarranty[]>> {
  const headers = buyerProofHeaders(request, null);
  if (!headers) return { ok: false, reason: "signed_out" };
  const response = await callApi("/api/v1/customer-auth/warranties", { method: "GET", headers }, READ_TIMEOUT_MS);
  if (!response?.ok) {
    const status = response?.status ?? 0;
    return { ok: false, reason: status === 401 ? "signed_out" : status === 403 || status === 404 ? "no_access" : "unavailable" };
  }
  const data = await envelopeData<{ items?: unknown }>(response);
  return data && Array.isArray(data.items)
    ? { ok: true, data: readBuyerWarranties(data.items) }
    : { ok: false, reason: "unavailable" };
}

export type ClaimResult =
  | { ok: true; claimId: string; conversationId: string }
  | { ok: false; flag: WarrantyClaimFlag };

function claimPaths(warrantyId: string, access: WarrantyAccess) {
  const base = access.kind === "account"
    ? `/api/v1/customer-auth/warranties/${encodeURIComponent(warrantyId)}`
    : `/api/v1/orders/receipt/${encodeURIComponent(access.orderId)}/warranties/${encodeURIComponent(warrantyId)}`;
  return { upload: `${base}/claim-attachments`, open: `${base}/claims` };
}

/** What a refused API answer means for the claim form. */
async function claimFlagFor(response: Response | null, access: WarrantyAccess, step: "upload" | "open"): Promise<WarrantyClaimFlag> {
  if (!response) return "unavailable";
  const { status } = response;
  if (status === 409) {
    const payload = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
    const code = payload?.error?.code;
    return code === "WARRANTY_CLAIM_OPEN" ? "exists" : code === "WARRANTY_NOT_ACTIVE" || code === "WARRANTY_EXPIRED" ? "inactive" : "unavailable";
  }
  await response.body?.cancel().catch(() => undefined);
  if (status === 400 || status === 413 || status === 422) return step === "upload" ? "photo" : "invalid";
  if (status === 401) return access.kind === "account" ? "signin" : "missing";
  if (status === 403 || status === 404) return access.kind === "account" ? "inactive" : "missing";
  if (status === 429) return "rate";
  if (status === 503 && step === "upload") return "photo";
  return "unavailable";
}

/**
 * The claim form post: what's wrong (the conversation form's `body`), up to
 * three photos (`images`) and the form's key (`clientMessageKey`, reused as the
 * claim's replay key, so a resubmitted form opens one claim).
 */
export async function openWarrantyClaimFromForm(
  request: Request,
  warrantyId: string,
  access: WarrantyAccess,
  form: FormData,
): Promise<ClaimResult> {
  const body = normalizeConversationBody(form.get("body"));
  const clientKey = form.get("clientMessageKey");
  if (!body.ok || !isClientMessageKey(clientKey) || clientKey.length > CLAIM_KEY_MAX) return { ok: false, flag: "invalid" };
  const images = checkAttachmentFiles(form.getAll("images"));
  if (!images.ok) return { ok: false, flag: "photo" };
  const receiptOrderId = access.kind === "receipt" ? access.orderId : null;
  const noProof: ClaimResult = { ok: false, flag: access.kind === "account" ? "signin" : "missing" };
  const paths = claimPaths(warrantyId, access);

  const attachmentIds: string[] = [];
  for (const file of images.files) {
    const headers = buyerProofHeaders(request, receiptOrderId);
    if (!headers) return noProof;
    const upload = new FormData();
    upload.append("file", file, file.name || "image");
    upload.append("clientKey", clientKey);
    const response = await callApi(paths.upload, { method: "POST", headers, body: upload }, UPLOAD_TIMEOUT_MS);
    if (!response || response.status !== 201) return { ok: false, flag: await claimFlagFor(response, access, "upload") };
    const data = await envelopeData<{ attachmentId?: unknown }>(response);
    if (!isConversationAttachmentId(data?.attachmentId)) return { ok: false, flag: "photo" };
    attachmentIds.push(data.attachmentId);
  }

  const headers = buyerProofHeaders(request, receiptOrderId);
  if (!headers) return noProof;
  headers.set("Content-Type", "application/json");
  const response = await callApi(paths.open, {
    method: "POST",
    headers,
    body: JSON.stringify({
      description: body.value,
      clientKey,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    }),
  }, WRITE_TIMEOUT_MS);
  if (!response || response.status !== 201) return { ok: false, flag: await claimFlagFor(response, access, "open") };
  const data = await envelopeData<{ claimId?: unknown; conversationId?: unknown }>(response);
  return isWarrantyClaimId(data?.claimId) && isConversationId(data?.conversationId)
    ? { ok: true, claimId: data.claimId, conversationId: data.conversationId }
    : { ok: false, flag: "unavailable" };
}
