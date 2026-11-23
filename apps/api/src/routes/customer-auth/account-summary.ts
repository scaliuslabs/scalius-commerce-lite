// The signed-in buyer's account summary: the counts that decide which account
// tabs show (a tab shows only when its count is > 0) and the account's own
// numbers a dashboard draws (orders, spend per currency, open conversations).
// Each count comes from its own domain's public entry, and none walks the
// buyer's orders: orders and spend are one row per currency
// (`account_order_totals`), the conversation counts read the buyer's threads
// (rules/orders/account-summary-reads-maintained-totals.md).
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { readBuyerInboxCounts } from "@scalius/core/modules/conversations";
import { readAccountOrderTotals } from "@scalius/core/modules/customers";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { fromMinor } from "@scalius/shared/money";
import { countBuyerDownloads } from "@scalius/core/modules/digital";
import { countBuyerGiftCards } from "@scalius/core/modules/gift-cards";
import { countReviewableLinesForCustomer, countWrittenReviewsForCustomer } from "@scalius/core/modules/reviews";
import { countActiveBuyerWarranties } from "@scalius/core/modules/warranty";
import { listActiveCheckoutRegistrations } from "@scalius/core/modules/plugins";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { buyerUiBlockSchema, PLUGIN_EXTENSION_RUN } from "@scalius/shared/plugins";
import { createCheckoutAppFunctions, requestBuyerLanguage } from "../../plugins/checkout-functions";
import { getOptionalExecutionContext } from "../../utils/execution-context";
import { ok } from "../../utils/api-response";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { UnauthorizedError } from "../../utils/api-error";
import { requireCustomerSession, setPrivateNoStoreHeaders } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

const count = z.number().int().nonnegative();

const accountSpendSchema = z.object({
  currencyCode: z.string().openapi({ description: "ISO 4217: the currency these orders were charged in." }),
  orders: count,
  amount: z.number().openapi({ description: "What the store holds of these orders: paid (net of refunds) less what banks took back in disputes, in major units." }),
  amountMinor: z.number().int().nonnegative(),
}).openapi("CustomerAccountSpend");

export const customerAccountSummarySchema = z.object({
  orders: count.openapi({ description: "Live orders the account owns that are not unfinished checkouts (any currency)." }),
  spent: z.array(accountSpendSchema).openapi({ description: "Lifetime spend per currency the account bought in, by currency code. Empty before the first order." }),
  openConversations: count.openapi({ description: "The account's conversations that are not closed (store threads and the threads of its orders)." }),
  unreadInbox: count,
  reviewsToWrite: count,
  reviewsWritten: count,
  downloads: count,
  giftCards: count,
  activeWarranties: count,
  buyerUi: z.array(buyerUiBlockSchema),
}).openapi("CustomerAccountSummary");

app.openapi(createRoute({
  method: "get",
  path: "/account-summary",
  tags: ["Customer Auth"],
  summary: "The account's numbers: orders, spend per currency, open conversations, and the counts behind the account tabs",
  request: { headers: z.object({
    "x-storefront-language": z.string().min(1).max(35).optional(),
    "x-storefront-locale": z.string().min(1).max(35).optional(),
  }) },
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
  const totals = await readAccountOrderTotals(db, customerId);
  const inbox = await readBuyerInboxCounts(db, customerId);
  const reviewsToWrite = await countReviewableLinesForCustomer(db, customerId);
  const reviewsWritten = await countWrittenReviewsForCustomer(db, customerId);
  const downloads = await countBuyerDownloads(db, customerId);
  const giftCards = await countBuyerGiftCards(db, customerId);
  const activeWarranties = await countActiveBuyerWarranties(db, customerId);
  const apps = createCheckoutAppFunctions({
    env: c.env,
    // The buyer's language: every app word and function run speaks it.
    language: requestBuyerLanguage(null, c.req.header("x-storefront-language")),
    ctx: getOptionalExecutionContext(c) as ExecutionContext | undefined,
    db,
    registrations: await listActiveCheckoutRegistrations(db),
    buyerRequest: c.req.raw,
  });
  const buyerUi = apps.points.has(PLUGIN_EXTENSION_RUN)
    ? await apps.buyerUi?.({
      targets: ["account.overview", "account.profile"],
      language: c.req.header("x-storefront-language"),
      locale: c.req.header("x-storefront-locale"),
      currency: (await readStoreCurrency(db)).code,
      customer: { id: customerId },
    }) ?? []
    : [];
  return ok(c, {
    orders: totals.orders,
    spent: totals.spent.map((row) => ({ ...row, amount: fromMinor(row.amountMinor, getDecimalPlaces(row.currencyCode)) })),
    openConversations: inbox.open,
    unreadInbox: inbox.unread,
    reviewsToWrite,
    reviewsWritten,
    downloads,
    giftCards,
    activeWarranties,
    buyerUi,
  });
});

export { app as customerAccountSummaryRoutes };
