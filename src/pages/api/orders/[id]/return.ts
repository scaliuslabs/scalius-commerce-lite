import type { APIRoute } from "astro";
import { db } from "@/db";
import { processReturn } from "@/modules/payments/refund-service";

export const POST: APIRoute = async ({ params, request, locals }) => {
    const { id: orderId } = params;
    if (!orderId) {
        return Response.json({ success: false, error: "Order ID required" }, { status: 400 });
    }

    try {
        const body = await request.json() as {
            reason?: string;
            autoRefund?: boolean;
        };

        const envCache = locals.runtime?.env?.CACHE as KVNamespace | undefined;

        const result = await processReturn(db, envCache, {
            orderId,
            reason: body.reason ?? "Customer return",
            autoRefund: body.autoRefund ?? false,
        });

        return Response.json(result, { status: result.success ? 200 : 400 });
    } catch (error) {
        console.error("Error processing return:", error);
        return Response.json({ success: false, error: "Failed to process return" }, { status: 500 });
    }
};
