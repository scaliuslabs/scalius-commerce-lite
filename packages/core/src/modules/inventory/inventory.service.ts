import { productVariants, products, inventoryMovements, productLowStockAlerts } from "@scalius/database/schema";
import { eq, sql, and, isNull, desc, asc, or, like } from "drizzle-orm";
import { checkAndAlertLowStock } from "./alerts";
import { safeBatch, type Database } from "@scalius/database/client";
import type { SQL } from "drizzle-orm";
import { NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import { buildStockMovementClaim } from "./stock-movement-claims";

export async function getInventoryOverview(db: Database, params: {
    section: string;
    search: string;
    status: string;
    page: number;
    limit: number;
    alertStatus?: string;
    sort?: string;
    order?: string;
}) {
    const { section, search, status, page, limit, alertStatus, sort, order } = params;
    const offset = (page - 1) * limit;

    if (section === "variants") {
        const conditions: (SQL | undefined)[] = [
            isNull(productVariants.deletedAt),
            eq(productVariants.trackInventory, true),
        ];

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

        const availableSql = sql<number>`(${productVariants.stock} - ${productVariants.reservedStock})`;
        const sortDirection = order === "desc" ? "desc" : "asc";
        const orderBy =
            sort === "productName"
                ? sortDirection === "desc" ? desc(products.name) : asc(products.name)
                : sort === "sku"
                    ? sortDirection === "desc" ? desc(productVariants.sku) : asc(productVariants.sku)
                    : sortDirection === "desc" ? desc(availableSql) : asc(availableSql);

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
                available: availableSql,
                lowStockThreshold: productVariants.lowStockThreshold,
                version: productVariants.version,
            })
            .from(productVariants)
            .leftJoin(products, eq(products.id, productVariants.productId))
            .where(and(...conditions))
            .orderBy(orderBy)
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
            .where(and(isNull(productVariants.deletedAt), eq(productVariants.trackInventory, true)))
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

    throw new ValidationError("Invalid section parameter");
}

export async function adjustInventory(db: Database, variantId: string, payload: {
    delta: number;
    reason: string;
    notes?: string;
    pool?: string;
}, adminUserId?: string) {
    const MAX_RETRIES = 3;
    const BASE_BACKOFF_MS = 50;
    const pool = payload.pool ?? "stock";
    const delta = Math.round(payload.delta);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const variant = await db
            .select({
                id: productVariants.id,
                stock: productVariants.stock,
                preorderStock: productVariants.preorderStock,
                stockVersion: productVariants.stockVersion,
            })
            .from(productVariants)
            .where(and(eq(productVariants.id, variantId), isNull(productVariants.deletedAt)))
            .get();

        if (!variant) {
            throw new NotFoundError("Variant not found");
        }

        const previousStock = pool === "preorderStock" ? variant.preorderStock : variant.stock;
        const newStock = Math.max(0, previousStock + delta);
        const effectiveDelta = newStock - previousStock;

        if (effectiveDelta === 0) {
            return {
                variantId,
                previousStock,
                newStock,
                delta: 0,
            };
        }

        const updateSet = pool === "preorderStock"
            ? {
                preorderStock: newStock,
                stockVersion: sql`${productVariants.stockVersion} + 1`,
                updatedAt: sql`unixepoch()`,
            }
            : {
                stock: newStock,
                stockVersion: sql`${productVariants.stockVersion} + 1`,
                updatedAt: sql`unixepoch()`,
            };

        const movementInsert = buildStockMovementClaim(db, {
            movementId: crypto.randomUUID(),
            variantId,
            stockVersion: variant.stockVersion,
            quantity: effectiveDelta,
            previousStock,
            newStock,
            notes: `Manual adjustment (${payload.reason})${payload.notes ? `: ${payload.notes}` : ""}`,
            adminUserId,
        });

        const stockUpdate = db
            .update(productVariants)
            .set(updateSet)
            .where(
                and(
                    eq(productVariants.id, variantId),
                    eq(productVariants.stockVersion, variant.stockVersion),
                    isNull(productVariants.deletedAt),
                )
            )
            .returning({ id: productVariants.id });

        const [movementRows, updateRows] = await safeBatch(
            db,
            [movementInsert, stockUpdate] as never,
        ) as { id: string }[][];

        if ((movementRows?.length ?? 0) > 0 && (updateRows?.length ?? 0) > 0) {
            if (effectiveDelta < 0 && pool === "stock") {
                await checkAndAlertLowStock(db, variantId);
            }

            return {
                variantId,
                previousStock,
                newStock,
                delta: effectiveDelta,
            };
        }

        // CAS conflict — retry with backoff
        if (attempt < MAX_RETRIES - 1) {
            const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
            await new Promise((resolve) => setTimeout(resolve, backoff));
        }
    }

    throw new ConflictError(
        `Failed to adjust inventory after ${MAX_RETRIES} retries due to concurrent modifications`
    );
}
