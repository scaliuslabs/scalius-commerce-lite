// src/pages/api/inventory/index.ts
// Admin API: Full inventory overview.
//
// GET - List all product variants with stock data, product names, search & filtering
//       Powers the rebuilt /admin/inventory dashboard.

import type { APIRoute } from "astro";
import { db } from "@/db";
import {
    productVariants,
    products,
    inventoryMovements,
    productLowStockAlerts,
} from "@/db/schema";
import { eq, sql, and, isNull, desc, or, like } from "drizzle-orm";

export const GET: APIRoute = async ({ url }) => {
    try {
        const search = url.searchParams.get("search") ?? "";
        const status = url.searchParams.get("status") ?? "all"; // all | low | out | reserved
        const page = parseInt(url.searchParams.get("page") || "1");
        const limit = parseInt(url.searchParams.get("limit") || "50");
        const section = url.searchParams.get("section") ?? "variants"; // variants | movements | alerts
        const offset = (page - 1) * limit;

        // --- Section: All Variants with Stock Data ---
        if (section === "variants") {
            const conditions = [isNull(productVariants.deletedAt)];

            // Stock status filters
            if (status === "low") {
                conditions.push(
                    sql`(${productVariants.stock} - ${productVariants.reservedStock}) > 0 AND (${productVariants.stock} - ${productVariants.reservedStock}) <= COALESCE(${productVariants.lowStockThreshold}, 5)`
                );
            } else if (status === "out") {
                conditions.push(
                    sql`(${productVariants.stock} - ${productVariants.reservedStock}) <= 0`
                );
            } else if (status === "reserved") {
                conditions.push(sql`${productVariants.reservedStock} > 0`);
            }

            // Search by product name or SKU
            if (search) {
                conditions.push(
                    or(
                        like(productVariants.sku, `%${search}%`),
                        sql`${products.name} LIKE ${"%" + search + "%"}`
                    )!
                );
            }

            const variants = await db
                .select({
                    id: productVariants.id,
                    productId: productVariants.productId,
                    productName: products.name,
                    sku: productVariants.sku,
                    size: productVariants.size,
                    color: productVariants.color,
                    price: productVariants.price,
                    stock: productVariants.stock,
                    reservedStock: productVariants.reservedStock,
                    available: sql<number>`(${productVariants.stock} - ${productVariants.reservedStock})`,
                    lowStockThreshold: productVariants.lowStockThreshold,
                    version: productVariants.version,
                })
                .from(productVariants)
                .leftJoin(products, eq(products.id, productVariants.productId))
                .where(and(...conditions))
                .orderBy(
                    sql`(${productVariants.stock} - ${productVariants.reservedStock}) ASC`
                )
                .limit(limit)
                .offset(offset)
                .all();

            // Get total count for pagination
            const countResult = await db
                .select({ count: sql<number>`count(*)` })
                .from(productVariants)
                .leftJoin(products, eq(products.id, productVariants.productId))
                .where(and(...conditions))
                .get();

            // Get summary stats
            const statsResult = await db
                .select({
                    totalVariants: sql<number>`count(*)`,
                    totalOnHand: sql<number>`COALESCE(SUM(${productVariants.stock}), 0)`,
                    totalReserved: sql<number>`COALESCE(SUM(${productVariants.reservedStock}), 0)`,
                    totalAvailable: sql<number>`COALESCE(SUM(${productVariants.stock} - ${productVariants.reservedStock}), 0)`,
                    outOfStockCount: sql<number>`SUM(CASE WHEN (${productVariants.stock} - ${productVariants.reservedStock}) <= 0 THEN 1 ELSE 0 END)`,
                    lowStockCount: sql<number>`SUM(CASE WHEN (${productVariants.stock} - ${productVariants.reservedStock}) > 0 AND (${productVariants.stock} - ${productVariants.reservedStock}) <= COALESCE(${productVariants.lowStockThreshold}, 5) THEN 1 ELSE 0 END)`,
                })
                .from(productVariants)
                .where(isNull(productVariants.deletedAt))
                .get();

            return Response.json({
                variants,
                pagination: {
                    page,
                    limit,
                    total: countResult?.count ?? 0,
                    totalPages: Math.ceil((countResult?.count ?? 0) / limit),
                },
                stats: statsResult ?? {
                    totalVariants: 0,
                    totalOnHand: 0,
                    totalReserved: 0,
                    totalAvailable: 0,
                    outOfStockCount: 0,
                    lowStockCount: 0,
                },
            });
        }

        // --- Section: Recent Inventory Movements ---
        if (section === "movements") {
            const movements = await db
                .select({
                    id: inventoryMovements.id,
                    variantId: inventoryMovements.variantId,
                    orderId: inventoryMovements.orderId,
                    type: inventoryMovements.type,
                    quantity: inventoryMovements.quantity,
                    previousStock: inventoryMovements.previousStock,
                    newStock: inventoryMovements.newStock,
                    notes: inventoryMovements.notes,
                    createdBy: inventoryMovements.createdBy,
                    createdAt: inventoryMovements.createdAt,
                    // Join variant SKU + product name
                    variantSku: productVariants.sku,
                    productName: products.name,
                })
                .from(inventoryMovements)
                .leftJoin(
                    productVariants,
                    eq(productVariants.id, inventoryMovements.variantId)
                )
                .leftJoin(products, eq(products.id, productVariants.productId))
                .orderBy(desc(inventoryMovements.createdAt))
                .limit(limit)
                .offset(offset)
                .all();

            return Response.json({ movements });
        }

        // --- Section: Low Stock Alerts ---
        if (section === "alerts") {
            const alertStatus = url.searchParams.get("alertStatus") ?? "active";

            const alerts = await db
                .select({
                    id: productLowStockAlerts.id,
                    variantId: productLowStockAlerts.variantId,
                    productId: productLowStockAlerts.productId,
                    currentQty: productLowStockAlerts.currentQty,
                    threshold: productLowStockAlerts.threshold,
                    alertStatus: productLowStockAlerts.alertStatus,
                    alertSentAt: productLowStockAlerts.alertSentAt,
                    acknowledgedAt: productLowStockAlerts.acknowledgedAt,
                    resolvedAt: productLowStockAlerts.resolvedAt,
                    productName: products.name,
                    variantSku: productVariants.sku,
                    variantSize: productVariants.size,
                    variantColor: productVariants.color,
                })
                .from(productLowStockAlerts)
                .leftJoin(products, eq(products.id, productLowStockAlerts.productId))
                .leftJoin(
                    productVariants,
                    eq(productVariants.id, productLowStockAlerts.variantId)
                )
                .where(
                    alertStatus === "all"
                        ? sql`1=1`
                        : eq(productLowStockAlerts.alertStatus, alertStatus)
                )
                .orderBy(desc(productLowStockAlerts.createdAt))
                .all();

            return Response.json({ alerts });
        }

        return Response.json({ error: "Invalid section parameter" }, { status: 400 });
    } catch (error) {
        console.error("Error fetching inventory data:", error);
        return Response.json({ error: "Failed to fetch inventory data" }, { status: 500 });
    }
};
