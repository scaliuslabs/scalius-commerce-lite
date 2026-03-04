import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as OrdersService from "@/modules/orders/orders.service";
import {
    createOrderSchema,
    updateOrderSchema,
    bulkDeleteOrderSchema,
    bulkShipOrderSchema
} from "@/modules/orders/orders.validation";
import { processReturn, processRefund } from "@/modules/payments/refund-service";
import { DeliveryService } from "@/modules/delivery/service";
import { orderPayments, paymentPlans, deliveryShipments } from "@/db/schema";
import { eq } from "drizzle-orm";
const app = new Hono<{
    Variables: {
        db: any;
        user: any;
        session: any;
    };
    Bindings: {
        CACHE: KVNamespace;
    };
}>();

// GET /api/v1/admin/orders (List)
app.get("/", async (c) => {
    try {
        const query = c.req.query();
        const result = await OrdersService.getOrders({
            page: parseInt(query.page || "1"),
            limit: parseInt(query.limit || "10"),
            search: query.search || "",
            status: query.status || undefined,
            showTrashed: query.trashed === "true",
            sort: (query.sort || "updatedAt") as any,
            order: (query.order || "desc") as "asc" | "desc",
            startDate: query.startDate ? new Date(query.startDate) : undefined,
            endDate: query.endDate ? new Date(query.endDate) : undefined,
        });
        return c.json(result);
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// POST /api/v1/admin/orders (Create)
app.post("/", zValidator("json", createOrderSchema), async (c) => {
    try {
        const data = c.req.valid("json");
        const result = await OrdersService.createOrder(data);
        return c.json(result, 201);
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// POST /api/v1/admin/orders/bulk-delete
app.post("/bulk-delete", zValidator("json", bulkDeleteOrderSchema), async (c) => {
    try {
        const data = c.req.valid("json");
        await OrdersService.bulkDeleteOrders(data.orderIds, data.permanent);
        return new Response(null, { status: 204 });
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// POST /api/v1/admin/orders/bulk-ship
app.post("/bulk-ship", zValidator("json", bulkShipOrderSchema), async (c) => {
    try {
        const data = c.req.valid("json");
        const results = await OrdersService.bulkShipOrders(data.orderIds, data.providerId, data.options);
        const successCount = results.filter((r) => r.success).length;
        return c.json({
            totalProcessed: results.length,
            successCount,
            failureCount: results.length - successCount,
            results,
        }, 200);
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// GET /api/v1/admin/orders/:id
app.get("/:id", async (c) => {
    try {
        const orderId = c.req.param("id");
        const result = await OrdersService.getOrderDetails(orderId);
        if (!result) return c.json({ error: "Order not found" }, 404);
        return c.json(result);
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// PUT /api/v1/admin/orders/:id
app.put("/:id", zValidator("json", updateOrderSchema), async (c) => {
    try {
        const orderId = c.req.param("id");
        const data = c.req.valid("json");
        const result = await OrdersService.updateOrder(orderId, data);
        return c.json(result, 200);
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// DELETE /api/v1/admin/orders/:id
app.delete("/:id", async (c) => {
    try {
        const orderId = c.req.param("id");
        await OrdersService.deleteOrder(orderId);
        return new Response(null, { status: 204 });
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// POST /api/v1/admin/orders/:id/restore
app.post("/:id/restore", async (c) => {
    try {
        const orderId = c.req.param("id");
        await OrdersService.restoreOrder(orderId);
        return new Response(null, { status: 204 });
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// DELETE /api/v1/admin/orders/:id/permanent
app.delete("/:id/permanent", async (c) => {
    try {
        const orderId = c.req.param("id");
        await OrdersService.permanentlyDeleteOrder(orderId);
        return new Response(null, { status: 204 });
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// GET /api/v1/admin/orders/:id/cod
app.get("/:id/cod", async (c) => {
    try {
        const orderId = c.req.param("id");
        const tracking = await c.get("db").select().from(require("@/db/schema").codTracking).where(require("drizzle-orm").eq(require("@/db/schema").codTracking.orderId, orderId)).get();
        return c.json({ tracking: tracking ?? null });
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// POST /api/v1/admin/orders/:id/cod
app.post("/:id/cod", zValidator("json", z.object({
    action: z.enum(["collected", "failed", "returned"]),
    collectedBy: z.string().optional(),
    collectedAmount: z.number().optional(),
    receiptUrl: z.string().optional(),
    reason: z.enum(["not_home", "refused", "no_cash", "wrong_address", "other"]).optional(),
    notes: z.string().optional()
})), async (c) => {
    try {
        const orderId = c.req.param("id");
        const data = c.req.valid("json");
        const result = await OrdersService.processCodAction(orderId, data);
        return c.json(result, 200);
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 400);
    }
});

// GET /api/v1/admin/orders/:id/fulfill
app.get("/:id/fulfill", async (c) => {
    try {
        const orderId = c.req.param("id");
        const shipments = await OrdersService.getOrderShipments(orderId);
        return c.json({ shipments });
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// POST /api/v1/admin/orders/:id/fulfill
app.post("/:id/fulfill", zValidator("json", z.object({
    itemIds: z.array(z.string()).optional(),
    trackingId: z.string().optional(),
    trackingUrl: z.string().optional(),
    courierName: z.string().optional(),
    note: z.string().optional(),
    isFinalShipment: z.boolean().optional(),
    shipmentAmount: z.number().optional()
})), async (c) => {
    try {
        const orderId = c.req.param("id");
        const data = c.req.valid("json");
        const result = await OrdersService.createFulfillmentShipment(orderId, data);
        return c.json(result, 201);
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 400);
    }
});

// PUT /api/v1/admin/orders/:id/status
app.put("/:id/status", zValidator("json", z.object({ status: z.string() })), async (c) => {
    try {
        const orderId = c.req.param("id");
        const data = c.req.valid("json");
        const result = await OrdersService.updateOrderStatus(orderId, data.status);
        return c.json(result, 200);
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 409);
    }
});

// GET /api/v1/admin/orders/:id/payments
app.get("/:id/payments", async (c) => {
    try {
        const orderId = c.req.param("id");
        const db = c.get("db") as any;

        const [payments, plan] = await Promise.all([
            db.select().from(orderPayments).where(eq(orderPayments.orderId, orderId)).all(),
            db.select().from(paymentPlans).where(eq(paymentPlans.orderId, orderId)).get()
        ]);

        return c.json({ payments, plan: plan ?? null });
    } catch (error: any) {
        console.error("Error fetching order payments:", error);
        return c.json({ error: "Failed to fetch payments" }, 500);
    }
});

// GET /api/v1/admin/orders/:id/shipments
app.get("/:id/shipments", async (c) => {
    try {
        const orderId = c.req.param("id");
        const deliveryService = new DeliveryService();
        const shipments = await deliveryService.getShipments(orderId);

        const enhancedShipments = await Promise.all(
            shipments.map(async (shipment) => {
                const provider = shipment.providerId ? await deliveryService.getProvider(shipment.providerId) : null;
                return {
                    ...shipment,
                    providerName: provider?.name || shipment.providerType,
                    lastChecked: shipment.lastChecked || shipment.updatedAt,
                };
            })
        );

        return c.json(enhancedShipments, 200);
    } catch (error: any) {
        console.error("Error fetching order shipments:", error);
        return c.json({ error: "Failed to fetch shipments" }, 500);
    }
});

// POST /api/v1/admin/orders/:id/shipments
app.post("/:id/shipments", zValidator("json", z.object({ providerId: z.string(), options: z.record(z.any()).optional() })), async (c) => {
    try {
        const orderId = c.req.param("id");
        const data = c.req.valid("json");
        const db = c.get("db") as any;
        const deliveryService = new DeliveryService();

        const shipmentResult = await deliveryService.createShipment(orderId, data.providerId, data.options);

        if (!shipmentResult.success) {
            console.error(`Failed to create shipment for order ${orderId}: ${shipmentResult.message}`);
            return c.json({ error: "Failed to create shipment", message: shipmentResult.message }, 400);
        }

        const provider = await deliveryService.getProvider(data.providerId);
        const createdShipment = await deliveryService.getLatestShipment(orderId);

        if (!createdShipment) {
            return c.json({ error: "Failed to retrieve created shipment" }, 500);
        }

        const now = new Date();
        await db.update(deliveryShipments).set({ lastChecked: now }).where(eq(deliveryShipments.id, createdShipment.id));

        const enhancedShipment = {
            ...createdShipment,
            providerName: provider?.name || createdShipment.providerType,
            lastChecked: now.toISOString(),
        };

        return c.json(enhancedShipment, 201);
    } catch (error: any) {
        console.error("Error creating order shipment:", error);
        return c.json({ error: "Failed to create shipment" }, 500);
    }
});

// POST /api/v1/admin/orders/:id/return
app.post("/:id/return", zValidator("json", z.object({ reason: z.string().optional(), autoRefund: z.boolean().optional() })), async (c) => {
    try {
        const orderId = c.req.param("id");
        const data = c.req.valid("json");
        const db = c.get("db") as any;
        const envCache = c.env?.CACHE;
        const result = await processReturn(db, envCache, { orderId, reason: data.reason ?? "Customer return", autoRefund: data.autoRefund ?? false });
        return c.json(result, result.success ? 200 : 400);
    } catch (error: any) {
        return c.json({ success: false, error: "Failed to process return" }, 500);
    }
});

// POST /api/v1/admin/orders/:id/refund
app.post("/:id/refund", zValidator("json", z.object({ amount: z.number().optional(), reason: z.string().optional(), gateway: z.enum(["stripe", "sslcommerz"]).optional() })), async (c) => {
    try {
        const orderId = c.req.param("id");
        const data = c.req.valid("json");
        const db = c.get("db") as any;
        const envCache = c.env?.CACHE;
        const result = await processRefund(db, envCache, { orderId, amount: data.amount, reason: data.reason ?? "Refund requested", gateway: data.gateway });
        return c.json(result, result.success ? 200 : 400);
    } catch (error: any) {
        return c.json({ success: false, error: "Failed to process refund" }, 500);
    }
});

export { app as adminOrdersRoutes };
