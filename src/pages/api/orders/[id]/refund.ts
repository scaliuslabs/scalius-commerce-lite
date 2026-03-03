import type { APIRoute } from "astro";
import { db } from "@/db";
import { processRefund } from "@/modules/payments/refund-service";

export const POST: APIRoute = async ({ params, request, locals }) => {
    const { id: orderId } = params;
    if (!orderId) {
        return Response.json({ success: false, error: "Order ID required" }, { status: 400 });
    }

    try {
        const body = await request.json() as {
            amount?: number;
            reason?: string;
            gateway?: "stripe" | "sslcommerz";
        };

        // Note: Astro API routes in this app have access to CF KV store via locals.runtime.env.CACHE
        // but the db instance is imported directly
        const envCache = locals.runtime?.env?.CACHE as KVNamespace | undefined;

        const result = await processRefund(db, envCache, {
            orderId,
            amount: body.amount,
            reason: body.reason ?? "Refund requested",
            gateway: body.gateway,
        });

        return Response.json(result, { status: result.success ? 200 : 400 });
    } catch (error) {
        console.error("Error processing refund:", error);
        return Response.json({ success: false, error: "Failed to process refund" }, { status: 500 });
    }
};
