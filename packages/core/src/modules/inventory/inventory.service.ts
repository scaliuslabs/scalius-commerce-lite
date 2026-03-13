import { productVariants, products, inventoryMovements, productLowStockAlerts } from "@scalius/database/schema";
import { eq, sql, and, isNull, desc, or, like } from "drizzle-orm";
import { recordMovement } from "./movements";
import { checkAndAlertLowStock } from "./alerts";

export const InventoryService = {
    async getInventoryOverview(db: any, params: {
        section: string;
        search: string;
        status: string;
        page: number;
        limit: number;
        alertStatus?: string;
    }) {
        const { section, search, status, page, limit, alertStatus } = params;
        const offset = (page - 1) * limit;

        if (section === "variants") {
            const conditions: any[] = [isNull(productVariants.deletedAt)];

            if (status === "low") {
                conditions.push(sql`(${productVariants.stock} - ${productVariants.reservedStock}) > 0 AND (${productVariants.stock} - ${productVariants.reservedStock}) <= COALESCE(${productVariants.lowStockThreshold}, 5)`);
            } else if (status === "out") {
                conditions.push(sql`(${productVariants.stock} - ${productVariants.reservedStock}) <= 0`);
            } else if (status === "reserved") {
                conditions.push(sql`${productVariants.reservedStock} > 0`);
            }

            if (search) {
                conditions.push(or(
                    like(productVariants.sku, `%${search}%`),
                    sql`${products.name} LIKE ${"%" + search + "%"}`
                ));
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
                .orderBy(sql`(${productVariants.stock} - ${productVariants.reservedStock}) ASC`)
                .limit(limit)
                .offset(offset)
                .all();

            const countResult = await db
                .select({ count: sql<number>`count(*)` })
                .from(productVariants)
                .leftJoin(products, eq(products.id, productVariants.productId))
                .where(and(...conditions))
                .get();

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

            return {
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
            };
        }

        if (section === "movements") {
            const countResult = await db.select({ count: sql<number>`count(*)` }).from(inventoryMovements).get();

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
                    variantSku: productVariants.sku,
                    productName: products.name,
                })
                .from(inventoryMovements)
                .leftJoin(productVariants, eq(productVariants.id, inventoryMovements.variantId))
                .leftJoin(products, eq(products.id, productVariants.productId))
                .orderBy(desc(inventoryMovements.createdAt))
                .limit(limit)
                .offset(offset)
                .all();

            return {
                movements,
                pagination: {
                    page,
                    limit,
                    total: countResult?.count ?? 0,
                    totalPages: Math.ceil((countResult?.count ?? 0) / limit),
                },
            };
        }

        if (section === "alerts") {
            const aStatus = alertStatus ?? "active";
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
                .leftJoin(productVariants, eq(productVariants.id, productLowStockAlerts.variantId))
                .where(
                    aStatus === "all"
                        ? sql`1=1`
                        : eq(productLowStockAlerts.alertStatus, aStatus)
                )
                .orderBy(desc(productLowStockAlerts.createdAt))
                .all();

            return { alerts };
        }

        const err = new Error("Invalid section parameter");
        (err as any).statusCode = 400;
        throw err;
    },

    async adjustInventory(db: any, variantId: string, payload: {
        delta: number;
        reason: string;
        notes?: string;
        pool?: string;
    }, adminUserId?: string) {
        const pool = payload.pool ?? "stock";
        const delta = Math.round(payload.delta);

        const variant = await db
            .select({
                id: productVariants.id,
                stock: productVariants.stock,
                preorderStock: productVariants.preorderStock,
            })
            .from(productVariants)
            .where(eq(productVariants.id, variantId))
            .get();

        if (!variant) {
            const err = new Error("Variant not found");
            (err as any).statusCode = 404;
            throw err;
        }

        const previousStock = pool === "preorderStock" ? variant.preorderStock : variant.stock;

        const updateSet = pool === "preorderStock"
            ? {
                preorderStock: sql`MAX(0, ${productVariants.preorderStock} + ${delta})`,
                version: sql`${productVariants.version} + 1`,
                updatedAt: sql`unixepoch()`,
            }
            : {
                stock: sql`MAX(0, ${productVariants.stock} + ${delta})`,
                version: sql`${productVariants.version} + 1`,
                updatedAt: sql`unixepoch()`,
            };

        await db
            .update(productVariants)
            .set(updateSet)
            .where(eq(productVariants.id, variantId));

        const newStock = Math.max(0, previousStock + delta);

        await recordMovement(db, {
            variantId,
            type: "adjusted",
            quantity: delta,
            previousStock,
            newStock,
            notes: `Manual adjustment (${payload.reason})${payload.notes ? `: ${payload.notes}` : ""}`,
            createdBy: adminUserId,
        });

        if (delta < 0 && pool === "stock") {
            await checkAndAlertLowStock(db, variantId);
        }

        return {
            success: true,
            variantId,
            previousStock,
            newStock,
            delta,
        };
    }
};
