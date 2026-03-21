import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getOrderDetails } from "@scalius/core/modules/orders";
import { getOrAssignInvoiceNumber } from "@scalius/core/modules/orders/invoice.service";
import { getBusinessSettings } from "@scalius/core/modules/settings/business-settings.service";
import { NotFoundError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { successEnvelope, errorResponses } from "../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── Response schema ────────────────────────────────────────────────

const orderItemSchema = z.object({
    id: z.string(),
    productId: z.string(),
    variantId: z.string().nullable(),
    quantity: z.number(),
    price: z.number(),
    productName: z.string().nullable(),
    productImage: z.string().nullable(),
    variantSize: z.string().nullable(),
    variantColor: z.string().nullable(),
}).passthrough();

const invoiceOrderSchema = z.object({
    id: z.string(),
    customerName: z.string(),
    customerPhone: z.string(),
    customerEmail: z.string().nullable(),
    totalAmount: z.number(),
    shippingCharge: z.number(),
    discountAmount: z.number().nullable(),
    status: z.string(),
    paymentStatus: z.string(),
    paymentMethod: z.string(),
    shippingAddress: z.string(),
    city: z.string(),
    zone: z.string(),
    area: z.string().nullable(),
    cityName: z.string().nullable(),
    zoneName: z.string().nullable(),
    areaName: z.string().nullable(),
    createdAt: z.union([z.string(), z.number()]),
    updatedAt: z.union([z.string(), z.number()]),
    items: z.array(orderItemSchema),
}).passthrough();

const businessInfoSchema = z.object({
    companyName: z.string(),
    legalName: z.string(),
    addressLine1: z.string(),
    addressLine2: z.string(),
    city: z.string(),
    stateRegion: z.string(),
    postalCode: z.string(),
    country: z.string(),
    phone: z.string(),
    email: z.string(),
    taxId: z.string(),
    invoicePrefix: z.string(),
    invoiceFooterText: z.string(),
    invoiceLogoUrl: z.string(),
});

const invoiceDataSchema = z.object({
    order: invoiceOrderSchema,
    invoiceNumber: z.string(),
    invoiceNum: z.number(),
    businessInfo: businessInfoSchema,
});

// ─── Route ──────────────────────────────────────────────────────────

const getInvoiceRoute = createRoute({
    method: "get",
    path: "/:id/invoice",
    tags: ["Admin - Orders"],
    summary: "Get invoice data for an order",
    request: {
        params: z.object({
            id: z.string().openapi({ description: "Order ID" }),
        }),
    },
    responses: {
        200: {
            description: "Invoice data with order details, business info, and invoice number",
            content: { "application/json": { schema: successEnvelope(invoiceDataSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(getInvoiceRoute, async (c) => {
    const db = c.get("db");
    const { id: orderId } = c.req.valid("param");

    const order = await getOrderDetails(db, orderId);
    if (!order) {
        throw new NotFoundError("Order not found");
    }

    const [businessInfo, invoiceResult] = await Promise.all([
        getBusinessSettings(db),
        getOrAssignInvoiceNumber(db, orderId),
    ]);

    return ok(c, {
        order,
        invoiceNumber: invoiceResult.formatted,
        invoiceNum: invoiceResult.invoiceNumber,
        businessInfo,
    });
});

export { app as adminOrdersInvoiceRoutes };
