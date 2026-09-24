// The signed-in customer's order history.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getAccountPhoneVerificationPrompt } from "@scalius/core/modules/customers/customer-auth.service";
import { getCustomerOrders } from "@scalius/core/modules/customers/customers.service";
import { linkVerifiedContactOrders } from "@scalius/core/modules/customers/customer-identity";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { nullableTimestampSchema } from "../../schemas/timestamps";
import { ok } from "../../utils/api-response";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { setPrivateNoStoreHeaders, requireCustomerSession } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── GET /orders ──────────────────────────────────────────────────────────────

const getCustomerOrdersRoute = createRoute({
  method: "get",
  path: "/orders",
  tags: ["Customer Auth"],
  summary: "Get orders for authenticated customer",
  request: {
    query: z.object({
      cursor: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }),
  },
  responses: {
    200: {
      description: "Customer orders list",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            orders: z.array(z.object({
              id: z.string(),
              orderNumber: z.number().int().nullable(),
              invoiceNumber: z.number().nullable().optional(),
              status: z.string(),
              statusLabel: z.string(),
              openSupportRequestType: z.string().nullable(),
              currencyCode: z.string(),
              totalAmount: z.number(),
              paidAmount: z.number(),
              balanceDue: z.number(),
              shippingCharge: z.number(),
              shippingMethodId: z.string().nullable(),
              shippingMethodName: z.string().nullable(),
              shippingMethodDescription: z.string().nullable(),
              shippingMethodBaseAmountMinor: z.number().int().nullable(),
              shippingFeeWaived: z.boolean().nullable(),
              discountAmount: z.number().nullable(),
              paymentStatus: z.string(),
              paymentMethod: z.string(),
              fulfillmentStatus: z.string(),
              expectedDelivery: z.string().nullable().optional(),
              shippingAddress: z.string(),
              cityName: z.string().nullable(),
              zoneName: z.string().nullable(),
              areaName: z.string().nullable().optional(),
              notes: z.string().nullable(),
              createdAt: nullableTimestampSchema,
              latestShipment: z.object({
                id: z.string(),
                providerType: z.string(),
                providerName: z.string().nullable(),
                status: z.string(),
                rawStatus: z.string().nullable(),
                trackingId: z.string().nullable(),
                trackingUrl: z.string().nullable(),
                courierName: z.string().nullable(),
                statusLabel: z.string(),
                lastChecked: nullableTimestampSchema,
                updatedAt: nullableTimestampSchema,
                createdAt: nullableTimestampSchema,
              }).nullable().optional(),
              items: z.array(z.object({
                productId: z.string(),
                variantId: z.string().nullable(),
                quantity: z.number(),
                price: z.number(),
                productName: z.string().nullable(),
                productSlug: z.string().nullable(),
                productImage: z.string().nullable(),
                variantLabel: z.string().nullable(),
              }).passthrough()),
            }).passthrough()),
            summary: z.object({
              totalOrders: z.number(),
              totalSpent: z.number(),
              completedOrders: z.number(),
              pendingOrders: z.number(),
            }),
            pagination: z.object({
              limit: z.number(),
              returned: z.number(),
              hasMore: z.boolean(),
              nextCursor: z.string().nullable(),
            }),
            phoneVerification: z.object({
              phone: z.string().openapi({ description: "The account's own phone (E.164)" }),
            }).nullable().openapi({
              description: "Set when the account's own phone is unverified and a text/WhatsApp code can reach it. Proving it adds orders placed with that phone.",
            }),
            customer: z.object({
              id: z.string().optional(),
              name: z.string(),
              email: z.string().optional(),
              phone: z.string().optional(),
              address: z.string().nullable().optional(),
              cityName: z.string().nullable().optional(),
              zoneName: z.string().nullable().optional(),
              city: z.string().nullable().optional(),
              zone: z.string().nullable().optional(),
              area: z.string().nullable().optional(),
              areaName: z.string().nullable().optional(),
            }),
          })),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getCustomerOrdersRoute, async (c) => {
  setPrivateNoStoreHeaders(c);

  const { session } = await requireCustomerSession(c);
  const query = c.req.valid("query");

  // Build a fallback customer profile from session data
  const sessionProfile = {
    name: session.name || "Customer",
    email: session.email,
    phone: session.phone
  };

  // Match orders EXCLUSIVELY by customerId
  if (!session.customerId) {
    return ok(c, {
      orders: [],
      customer: sessionProfile,
      summary: {
        totalOrders: 0,
        totalSpent: 0,
        completedOrders: 0,
        pendingOrders: 0,
      },
      pagination: {
        limit: query.limit ?? 50,
        returned: 0,
        hasMore: false,
        nextCursor: null,
      },
      phoneVerification: null,
    });
  }

  const db = c.get("db");
  // Orders placed signed out (any device) with a verified email/phone join
  // the history here, not only at sign-in.
  await linkVerifiedContactOrders(db, session.customerId);
  const [result, phoneVerification] = await Promise.all([
    getCustomerOrders(db, session.customerId, query),
    getAccountPhoneVerificationPrompt(db, session.customerId, getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>)),
  ]);

  // Merge session data into profile (DB profile wins, session fills gaps)
  const customer = result.customerProfile
    ? {
        ...result.customerProfile,
        name: result.customerProfile.name || session.name || "Customer",
        email: result.customerProfile.email || session.email,
        phone: result.customerProfile.phone || session.phone,
      }
    : sessionProfile;

  return ok(c, {
    orders: result.orders,
    customer,
    summary: result.summary,
    pagination: result.pagination,
    phoneVerification,
  });
});

export { app as customerOrderListRoutes };
