import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { buyerCredentialHeaders, callApi, conversationApiPaths, isReceiptTarget, type ConversationTarget } from "./account-inbox-server";
import { readBoundedText } from "./newsletter-one-click";
import { parseConversationCartShare, validSharedCartLines } from "./conversation-cart-share";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const failure = (status: number) => Response.json({ success: false }, { status, headers });

/** Same-origin credential bridge. Cart identities never enter a query string or a log. */
export async function proxyConversationCartShare(request: Request, target: ConversationTarget | null): Promise<Response> {
  const site = request.headers.get("Sec-Fetch-Site");
  if ((site && site !== "same-origin" && site !== "none") || shouldRejectCrossOriginCookieRequest(request)
    || !request.headers.get("Accept")?.includes("application/json")) return failure(403);
  if (!target || target.kind === "claim") return failure(404);
  const proof = buyerCredentialHeaders(request, target);
  if (!proof) return failure(isReceiptTarget(target) ? 404 : 401);
  let body: string | undefined;
  if (request.method !== "GET") {
    if (!["PUT", "DELETE"].includes(request.method)) return failure(405);
    if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json") return failure(415);
    const raw = await readBoundedText(request, 32 * 1024);
    if (raw === null) return failure(413);
    let input: { expectedVersion?: unknown; lines?: unknown } | null;
    try { input = JSON.parse(raw); } catch { return failure(400); }
    const minimum = request.method === "DELETE" ? 1 : 0;
    if (!input || !Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < minimum
      || (input.expectedVersion as number) >= Number.MAX_SAFE_INTEGER) return failure(400);
    if (request.method === "PUT" && (!validSharedCartLines(input.lines) || input.lines.length === 0)) return failure(400);
    body = JSON.stringify({ expectedVersion: input.expectedVersion, ...(request.method === "PUT" ? {
      lines: (input.lines as import("./conversation-cart-share").SharedCartLine[]).map(({ productId, skuId, quantity }) => ({ productId, skuId, quantity })),
    } : {}) });
    proof.set("Content-Type", "application/json");
  }
  const upstream = await callApi(`${conversationApiPaths(target).read}/cart-share`, { method: request.method, headers: proof, body }, 10_000);
  if (!upstream?.ok) return failure(upstream && [400, 401, 403, 404, 409, 422, 429].includes(upstream.status) ? upstream.status : 503);
  const envelope = await upstream.json().catch(() => null) as { success?: boolean; data?: { cartShare?: unknown } } | null;
  const cartShare = envelope?.success ? parseConversationCartShare(envelope.data?.cartShare) : undefined;
  if (cartShare === undefined || (request.method !== "GET" && cartShare === null)) return failure(503);
  return Response.json({ success: true, data: { cartShare } }, { headers });
}
