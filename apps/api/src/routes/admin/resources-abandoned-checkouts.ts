// Abandoned checkouts in the stable app API (operation-registry/README.md),
// mounted at /admin/resources: the cursor list a cart-recovery app walks and
// one checkout by id, each as its `checkout.abandoned` webhook carries it
// (`AbandonedCheckout`: lines and totals in minor units, currency, market
// presence and language, the customer and their marketing consent, a signed
// recovery link). The buyer's name, email and phone are protected: an app
// reads them only under its read_customer_* grants. A checkout that became an
// order, or aged out, is gone (404): that is how an app knows not to send.
import { createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { gte, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { abandonedCheckouts } from "@scalius/database/schema";
import { readAbandonedCheckoutRepresentations } from "@scalius/core/modules/checkout";
import { keysetOrderBy } from "@scalius/core/utils/keyset";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import { adminRouter } from "./admin-router";
import { ok } from "../../utils/api-response";
import { NotFoundError } from "../../utils/api-error";
import { errorResponses, namedSharedSchema, successEnvelope } from "../../schemas/responses";
import { nextCursorSchema } from "../../utils/bounded-page";
import { epochSeconds, resourcePage, resourcePageQuery, updatedOrder } from "../../utils/resource-page";

const app = adminRouter();

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
};
app.use("*", noStore);

const AbandonedCheckout = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.checkout, "AbandonedCheckout");
const readResponses = { 400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 429: errorResponses[429], 500: errorResponses[500] };
const runtime = (env: Env) => ({ env, storefrontUrl: env.STOREFRONT_URL });

app.openapi(createRoute({
  operationId: "dashboard.resources.abandoned_checkouts.list",
  method: "get",
  path: "/abandoned-checkouts",
  tags: ["App API - Abandoned checkouts"],
  summary: "List abandoned checkouts, least recently updated first",
  description: "Checkouts buyers left, as the checkout.abandoned webhook carries them (AbandonedCheckout: lines and totals in minor units, currency, market presence and language, the matching customer and their marketing consent, a signed recovery link), in (updatedAt, id) order. Filter by status (abandoned: idle an hour; open: still being filled in), start a sync with updatedSince and follow nextCursor. A checkout that became an order or aged out is not listed.",
  request: {
    query: z.object({
      ...resourcePageQuery,
      status: z.enum(["open", "abandoned"]).optional().openapi({ description: "Only checkouts in this state; omitted, both." }),
    }),
  },
  responses: {
    200: { description: "A page of abandoned checkouts", content: { "application/json": { schema: successEnvelope(z.object({ abandonedCheckouts: z.array(AbandonedCheckout), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const where: SQL[] = [];
  if (query.status) where.push(query.status === "abandoned" ? isNotNull(abandonedCheckouts.abandonedAt) : isNull(abandonedCheckouts.abandonedAt));
  if (query.updatedSince) where.push(gte(sql`${abandonedCheckouts.updatedAt}`, epochSeconds(query.updatedSince)));
  const order = updatedOrder(abandonedCheckouts.updatedAt, abandonedCheckouts.id);
  const page = await resourcePage({
    order,
    cursor: query.cursor,
    limit: query.limit,
    where,
    ids: (condition, limit) => db.select({ id: abandonedCheckouts.id }).from(abandonedCheckouts).where(condition).orderBy(...keysetOrderBy(order)).limit(limit).all(),
    load: (ids) => readAbandonedCheckoutRepresentations(db, ids, runtime(c.env)),
  });
  return ok(c, { abandonedCheckouts: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.abandoned_checkouts.get",
  method: "get",
  path: "/abandoned-checkouts/{id}",
  tags: ["App API - Abandoned checkouts"],
  summary: "Get one abandoned checkout",
  description: "One checkout as the checkout.abandoned webhook carries it. Not found once it became an order (recovered) or aged out: read it right before a reminder, and send nothing then.",
  request: { params: z.object({ id: z.string().min(1).max(128) }) },
  responses: {
    200: { description: "The checkout", content: { "application/json": { schema: successEnvelope(z.object({ abandonedCheckout: AbandonedCheckout })) } } },
    404: errorResponses[404],
    ...readResponses,
  },
}), async (c) => {
  const [abandonedCheckout] = await readAbandonedCheckoutRepresentations(c.get("db"), [c.req.valid("param").id], runtime(c.env));
  if (!abandonedCheckout) throw new NotFoundError("Abandoned checkout not found.");
  return ok(c, { abandonedCheckout });
});

export { app as adminResourceAbandonedCheckoutRoutes };
