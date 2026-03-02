import type { APIRoute } from "astro";
import { db } from "../../../../../db";
import { productVariants } from "../../../../../db/schema";
import { sql, eq, and } from "drizzle-orm";
import { z } from "zod";

const bulkUpdateSchema = z.object({
    updates: z.array(
        z.object({
            id: z.string(),
            size: z.string().nullable().optional(),
            color: z.string().nullable().optional(),
            weight: z.number().nullable().optional(),
            sku: z.string().optional(),
            price: z.number().min(0).optional(),
            stock: z.number().min(0).optional(),
        })
    ),
});

export const POST: APIRoute = async ({ request, params }) => {
    try {
        const { id: productId } = params;
        if (!productId) {
            return new Response(
                JSON.stringify({
                    error: "Product ID is required",
                }),
                { status: 400 },
            );
        }

        const json = await request.json();
        const data = bulkUpdateSchema.parse(json);

        if (data.updates.length === 0) {
            return new Response(
                JSON.stringify({
                    error: "No updates provided",
                }),
                { status: 400 },
            );
        }

        // Perform bulk updates in a batch
        const statements = [];
        for (const update of data.updates) {
            const { id, ...fieldsToUpdate } = update;

            if (Object.keys(fieldsToUpdate).length === 0) continue;

            statements.push(
                db
                    .update(productVariants)
                    .set({
                        ...fieldsToUpdate,
                        updatedAt: sql`unixepoch()`,
                    })
                    .where(
                        and(
                            eq(productVariants.id, id),
                            eq(productVariants.productId, productId)
                        )
                    )
            );
        }

        if (statements.length > 0) {
            await db.batch(statements as any);
        }

        return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (error) {
        console.error("Error bulk updating variants:", error);

        if (error instanceof z.ZodError) {
            return new Response(
                JSON.stringify({
                    error: "Invalid request data",
                    details: error.errors,
                }),
                { status: 400 },
            );
        }

        return new Response(
            JSON.stringify({
                error: "Internal server error",
            }),
            { status: 500 },
        );
    }
};
