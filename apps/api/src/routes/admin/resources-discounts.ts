// Discounts in the stable app API (operation-registry/README.md), mounted at
// /admin/resources: the cursor list a discount sync walks, each discount as
// its webhooks carry it (`DiscountSummary`, the `discount` representation),
// in (updatedAt, id) order with `updatedSince`, or by `ids` (where a truncated
// discount delivery points, since only this read answers that shape). Its rules, codes and usage are
// `discounts.get` (`DiscountResource`); the dashboard's searched,
// page-numbered list stays `dashboard.discounts.list` (beta).
import { createRoute, z } from "@hono/zod-openapi";
import { adminRouter } from "./admin-router";
import type { MiddlewareHandler } from "hono";
import { eq, gte, sql, type SQL } from "drizzle-orm";
import { promotions } from "@scalius/database/schema";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import { keysetOrderBy } from "@scalius/core/utils/keyset";
import { ok } from "../../utils/api-response";
import { errorResponses, namedSharedSchema, successEnvelope } from "../../schemas/responses";
import { nextCursorSchema } from "../../utils/bounded-page";
import { epochSeconds, resourcePage, resourcePageQuery, updatedOrder } from "../../utils/resource-page";
import { readDiscountRepresentations } from "../../events/discount-representations";
import { idsCondition, listIdsQuery } from "./resources";

const app = adminRouter();

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
};
app.use("*", noStore);

const DiscountSummary = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.discount, "DiscountSummary");
const DISCOUNT_STATUSES = ["draft", "active", "paused", "archived"] as const;
const readResponses = { 400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 429: errorResponses[429], 500: errorResponses[500] };

app.openapi(createRoute({
  operationId: "dashboard.resources.discounts.list",
  method: "get",
  path: "/discounts",
  tags: ["App API - Discounts"],
  summary: "List discounts, least recently updated first",
  description: "Code and automatic discounts as webhooks carry them (DiscountSummary: status, schedule, code and redemption counts, revision), archived ones included, in (updatedAt, id) order. Start a sync with updatedSince and follow nextCursor, or read named discounts with ids; read a discount's rules and codes with discounts.get.",
  request: {
    query: z.object({
      ...resourcePageQuery,
      ids: listIdsQuery,
      status: z.enum(DISCOUNT_STATUSES).optional().openapi({ description: "Only discounts in this status; omitted, every status (archived too)." }),
    }),
  },
  responses: {
    200: { description: "A page of discounts", content: { "application/json": { schema: successEnvelope(z.object({ discounts: z.array(DiscountSummary), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const where: SQL[] = [];
  if (query.status) where.push(eq(promotions.status, query.status));
  if (query.updatedSince) where.push(gte(sql`${promotions.updatedAt}`, epochSeconds(query.updatedSince)));
  const named = idsCondition(promotions.id, query.ids);
  if (named) where.push(named);
  const order = updatedOrder(promotions.updatedAt, promotions.id);
  const page = await resourcePage({
    order,
    cursor: query.cursor,
    limit: query.limit,
    where,
    ids: (condition, limit) => db.select({ id: promotions.id }).from(promotions).where(condition).orderBy(...keysetOrderBy(order)).limit(limit).all(),
    load: (ids) => readDiscountRepresentations(db, ids),
  });
  return ok(c, { discounts: page.items, nextCursor: page.nextCursor });
});

export { app as adminResourceDiscountRoutes };
