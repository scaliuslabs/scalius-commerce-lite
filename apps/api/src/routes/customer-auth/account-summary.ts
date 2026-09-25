// The signed-in buyer's account summary (Wave B design §7.1): the counts that
// decide which account tabs show (a tab shows only when its count is > 0).
// Each count comes from its own domain's public entry. Until B1/B3/B4/B5 fill
// their stubs the four feature counts are 0 and cost no database read.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { countBuyerUnread } from "@scalius/core/modules/conversations";
import { countBuyerDownloads } from "@scalius/core/modules/digital";
import { countBuyerGiftCards } from "@scalius/core/modules/gift-cards";
import { countReviewableLinesForCustomer } from "@scalius/core/modules/reviews";
import { countActiveBuyerWarranties } from "@scalius/core/modules/warranty";
import { ok } from "../../utils/api-response";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { UnauthorizedError } from "../../utils/api-error";
import { requireCustomerSession, setPrivateNoStoreHeaders } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

const count = z.number().int().nonnegative();

export const customerAccountSummarySchema = z.object({
  unreadInbox: count,
  reviewsToWrite: count,
  downloads: count,
  giftCards: count,
  activeWarranties: count,
}).openapi("CustomerAccountSummary");

app.openapi(createRoute({
  method: "get",
  path: "/account-summary",
  tags: ["Customer Auth"],
  summary: "Counts behind the account tabs (inbox, reviews, downloads, gift cards, warranties)",
  responses: {
    200: {
      description: "Account summary",
      content: { "application/json": { schema: successEnvelope(customerAccountSummarySchema) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const { session } = await requireCustomerSession(c);
  const customerId = session.customerId;
  if (!customerId) throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  const db = c.get("db");
  // Sequential on purpose: each count is one indexed read at most, and the
  // request stays far below the six-connection limit.
  const unreadInbox = await countBuyerUnread(db, customerId);
  const reviewsToWrite = await countReviewableLinesForCustomer(db, customerId);
  const downloads = await countBuyerDownloads(db, customerId);
  const giftCards = await countBuyerGiftCards(db, customerId);
  const activeWarranties = await countActiveBuyerWarranties(db, customerId);
  return ok(c, { unreadInbox, reviewsToWrite, downloads, giftCards, activeWarranties });
});

export { app as customerAccountSummaryRoutes };
