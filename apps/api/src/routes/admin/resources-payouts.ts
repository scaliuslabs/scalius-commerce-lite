// Payouts in the stable app API (operation-registry/README.md), mounted at
// /admin/resources: an app (a marketplace paying its sellers) sends money to
// a payee through an installed payout provider (the `payout` port) and reads
// the payouts it sent, never another app's. Only an app calls them (staff
// and agents: 403 `app_principal_required`), under the Sensitive
// `write_payouts`.
//
// `payouts.create` takes the required Idempotency-Key. The payout is
// committed `pending` before the provider call, one per key (core
// `recordPayout`); the provider is called with the payout's id, which it
// applies once (plugins/providers/payout.ts). A decline answers the payout
// `failed` with its `failureCode`. A provider answer that is unknown is 503
// `payout_outcome_unknown` (`details.payoutId`), which is never kept as the
// key's answer: repeat the same request with the same key and it is
// resubmitted, never sent twice. The key with a different request is 409
// `payout_request_mismatch`. Money is integer minor units of `currency`.
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { payouts, PAYOUT_STATUSES } from "@scalius/database/schema";
import { getAppPayout, listAppPayouts, payoutRepresentation, PAYOUT_LIST_MAX } from "@scalius/core/modules/payouts";
import { keysetCondition } from "@scalius/core/utils/keyset";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import type { ListCursorShape } from "@scalius/shared/pagination";
import { MAX_MINOR_AMOUNT } from "@scalius/shared/money";
import { adminRouter } from "./admin-router";
import { idempotencyKeyHeaderSchema } from "./idempotency";
import { requestAppId } from "./request-actor";
import { conflictResponse, errorResponses, namedSharedSchema, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import { nextCursorSchema } from "../../utils/bounded-page";
import { created, ok } from "../../utils/api-response";
import { AppError, NotFoundError } from "../../utils/api-error";
import { epochSeconds, keysetRowsPage, resourcePageQueryWith, updatedOrder } from "../../utils/resource-page";
import { PAYOUT_OUTCOME_UNKNOWN_CODE, sendPayout } from "../../plugins/providers/payout";

const app = adminRouter();

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});

const TAG = "App API - Payouts";
const PayoutResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.payout, "PayoutResource");
const payoutEnvelope = successEnvelope(z.object({ payout: PayoutResource }));
const idParam = z.object({ id: z.string().min(1).max(128) });
const readResponses = { 400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404], 429: errorResponses[429], 500: errorResponses[500] };

/** The calling app: payouts are sent and read by apps only. */
function appIdOf(c: Context): string {
  const appId = requestAppId(c);
  if (!appId) throw new AppError(403, "app_principal_required", "Only an app sends and reads its payouts.");
  return appId;
}

const LIST_CURSOR: ListCursorShape = { sort: "updatedAt", direction: "asc", kinds: ["number"] };
const LIST_ORDER = updatedOrder(payouts.updatedAt, payouts.id);

app.openapi(createRoute({
  operationId: "dashboard.resources.payouts.list",
  method: "get",
  path: "/payouts",
  tags: [TAG],
  summary: "List the app's payouts, least recently updated first",
  description: "The payouts this app sent (PayoutResource), in (updatedAt, id) order, money in minor units of `currency`. `status` narrows to pending, processing, paid or failed; start a sync with updatedSince and follow nextCursor. Another app's payouts are never listed.",
  request: {
    query: z.object({
      ...resourcePageQueryWith(PAYOUT_LIST_MAX, 20),
      status: z.enum(PAYOUT_STATUSES).optional().openapi({ description: "Only payouts in this status." }),
    }),
  },
  responses: {
    200: { description: "A page of payouts", content: { "application/json": { schema: successEnvelope(z.object({ payouts: z.array(PayoutResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const appId = appIdOf(c);
  const query = c.req.valid("query");
  const db = c.get("db");
  const page = await keysetRowsPage({
    shape: LIST_CURSOR,
    after: (cursor) => keysetCondition(LIST_ORDER, cursor),
    cursor: query.cursor,
    limit: query.limit,
    where: [],
    rows: (after, limit) => listAppPayouts(db, {
      appId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.updatedSince ? { updatedSinceSeconds: epochSeconds(query.updatedSince) } : {}),
      ...(after ? { after } : {}),
      limit,
    }),
    load: (rows) => rows.map(payoutRepresentation),
    position: (payout) => ({ values: [epochSeconds(payout.updatedAt)], id: payout.id }),
  });
  return ok(c, { payouts: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.payouts.get",
  method: "get",
  path: "/payouts/{id}",
  tags: [TAG],
  summary: "Get one of the app's payouts",
  description: "A payout this app sent, as `payout.created` and `payout.updated` deliveries carry it. Another app's payout reads as 404.",
  request: { params: idParam },
  responses: {
    200: { description: "The payout", content: { "application/json": { schema: payoutEnvelope } } },
    ...readResponses,
  },
}), async (c) => {
  const row = await getAppPayout(c.get("db"), appIdOf(c), c.req.valid("param").id);
  if (!row) throw new NotFoundError("Payout not found");
  return ok(c, { payout: payoutRepresentation(row) });
});

/** Sending money: the key is required, so a retry after a lost response never pays twice. */
const payoutKeyHeaders = z.object({
  "idempotency-key": idempotencyKeyHeaderSchema.shape["idempotency-key"].unwrap().openapi({
    description: "Required: one key sends one payout; a repeat answers it (or resubmits it while its outcome is unknown).",
  }),
});

const PayoutCreateInput = z.object({
  providerId: z.string().min(3).max(160).openapi({ description: "The payout provider, `<app id>:<provider id>` (an installed, set-up payout app)." }),
  payeeRef: z.string().trim().min(1).max(128).openapi({ description: "Your own reference for the payee (a seller id)." }),
  payeeAccountRef: z.string().trim().min(1).max(256).optional().openapi({ description: "The provider's reference for the payee's account (a wallet number, a connected account id); leave it out when the provider looks it up from payeeRef." }),
  amountMinor: z.number().int().positive().max(MAX_MINOR_AMOUNT).openapi({ description: "What to send, in minor units of `currency`." }),
  currency: z.string().regex(/^[A-Z]{3}$/).openapi({ description: "ISO 4217 code of the amount." }),
  description: z.string().trim().min(1).max(200).optional().openapi({ description: "Shown on the payee's statement where the provider supports it." }),
}).strict();

app.openapi(createRoute({
  operationId: "dashboard.resources.payouts.create",
  method: "post",
  path: "/payouts",
  tags: [TAG],
  summary: "Send a payout to a payee",
  description: "Records the payout (pending) and sends it through the payout provider, which applies it once per payout id. Answers 201 with the payout: processing, paid, or failed with its `failureCode` (a decline). An unknown provider answer is 503 `payout_outcome_unknown` with `details.payoutId`: repeat the same request with the same Idempotency-Key to resubmit it; it is never sent twice. A repeat of an answered payout answers it without calling the provider. The key with another request is refused: 422 `idempotency_key_reused` within the key's 24 hours, then 409 `payout_request_mismatch` for good; a provider that is not an installed, active, set-up payout provider is 422 `payout_provider_unavailable`, with nothing recorded. Only an app sends payouts.",
  request: {
    headers: payoutKeyHeaders,
    body: { required: true, content: { "application/json": { schema: PayoutCreateInput } } },
  },
  responses: {
    200: { description: "The payout this key already sent", content: { "application/json": { schema: payoutEnvelope } } },
    201: { description: "The payout", content: { "application/json": { schema: payoutEnvelope } } },
    ...errorResponses,
    409: conflictResponse,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  const appId = appIdOf(c);
  const body = c.req.valid("json");
  const result = await sendPayout(c, {
    appId,
    providerId: body.providerId,
    payeeRef: body.payeeRef,
    payeeAccountRef: body.payeeAccountRef ?? null,
    amountMinor: body.amountMinor,
    currency: body.currency,
    description: body.description ?? null,
    idempotencyKey: c.req.valid("header")["idempotency-key"],
  });
  if (result.outcome === "unknown") {
    throw new AppError(503, PAYOUT_OUTCOME_UNKNOWN_CODE,
      "The payout is recorded, but the provider's answer is unknown. Send the same request again with the same Idempotency-Key to resubmit it; it is never sent twice.",
      { payoutId: result.payout.id, status: result.payout.status });
  }
  const answer = { payout: payoutRepresentation(result.payout) };
  return result.created ? created(c, answer) : ok(c, answer);
});

export { app as adminResourcePayoutRoutes };
