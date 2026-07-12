import { productVariants, products, inventoryMovements, productLowStockAlerts, user as adminUsers } from "@scalius/database/schema";
import { eq, sql, and, isNull, desc, asc, or, like } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import type { SQL } from "drizzle-orm";
import { ValidationError } from "@scalius/core/errors";
import { buildInventoryLowStockCondition } from "./low-stock-policy";
import { operationalSkuRowPredicate } from "../products/products.public-eligibility";
import { variantOptionLabelSql } from "../products/products.option-model";
import { adjustInventorySchema } from "./inventory.validation";
import { executeInventoryOperation } from "./inventory-operations";

const ALLOWED_INVENTORY_SECTIONS: ReadonlySet<string> = new Set(["variants", "movements", "alerts"]);
const ALLOWED_INVENTORY_STATUSES: ReadonlySet<string> = new Set(["all", "low", "out", "reserved"]);
const ALLOWED_ALERT_STATUSES: ReadonlySet<string> = new Set(["active", "acknowledged", "resolved", "all"]);
const ALLOWED_INVENTORY_SORTS: ReadonlySet<string> = new Set(["productName", "sku", "available"]);
const ALLOWED_SORT_ORDERS: ReadonlySet<string> = new Set(["asc", "desc"]);
const ALLOWED_MOVEMENT_TYPES: ReadonlySet<string> = new Set([
    "all",
    "reserved",
    "deducted",
    "released",
    "adjusted",
    "restored",
    "preorder_reserved",
    "preorder_deducted",
]);
const MAX_MOVEMENT_CURSOR_LENGTH = 512;

type InventoryMovementCursor = {
    createdAt: number;
    id: string;
};

export function encodeInventoryMovementCursor(cursor: InventoryMovementCursor): string {
    return `${cursor.createdAt}|${encodeURIComponent(cursor.id)}`;
}

export function decodeInventoryMovementCursor(value: string): InventoryMovementCursor {
    if (!value || value.length > MAX_MOVEMENT_CURSOR_LENGTH) {
        throw new ValidationError("Invalid inventory movement cursor");
    }
    const separator = value.indexOf("|");
    if (separator < 1) throw new ValidationError("Invalid inventory movement cursor");
    const createdAt = Number(value.slice(0, separator));
    let id: string;
    try {
        id = decodeURIComponent(value.slice(separator + 1));
    } catch {
        throw new ValidationError("Invalid inventory movement cursor");
    }
    if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !id || id.length > 256) {
        throw new ValidationError("Invalid inventory movement cursor");
    }
    return { createdAt, id };
}

function movementTimestampSeconds(value: Date | number | string): number {
    if (value instanceof Date) return Math.floor(value.getTime() / 1000);
    if (typeof value === "number") return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
    const parsed = new Date(value).getTime();
    if (!Number.isFinite(parsed)) throw new ValidationError("Inventory movement timestamp is invalid");
    return Math.floor(parsed / 1000);
}

export async function listInventoryMovements(db: Database, params: {
    search?: string;
    movementType?: string;
    orderId?: string;
    startDate?: Date;
    endDate?: Date;
    cursor?: string;
    limit: number;
}) {
    const search = params.search?.trim() ?? "";
    const orderId = params.orderId?.trim() ?? "";
    if (search.length > 120) throw new ValidationError("Inventory search must be at most 120 characters");
    if (orderId.length > 100) throw new ValidationError("Inventory order ID must be at most 100 characters");
    if (params.movementType && !ALLOWED_MOVEMENT_TYPES.has(params.movementType)) {
        throw new ValidationError("Invalid movement type parameter");
    }
    if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100) {
        throw new ValidationError("Inventory movement page size must be between 1 and 100");
    }
    if (params.startDate && !Number.isFinite(params.startDate.getTime())) {
        throw new ValidationError("Inventory movement start date is invalid");
    }
    if (params.endDate && !Number.isFinite(params.endDate.getTime())) {
        throw new ValidationError("Inventory movement end date is invalid");
    }
    if (params.startDate && params.endDate && params.startDate > params.endDate) {
        throw new ValidationError("Inventory movement start date must not be after end date");
    }

    const conditions: SQL[] = [];
    if (params.movementType && params.movementType !== "all") {
        conditions.push(eq(inventoryMovements.type, params.movementType));
    }
    if (search) {
        const searchPattern = `%${search}%`;
        conditions.push(or(
            like(productVariants.sku, searchPattern),
            like(products.name, searchPattern),
        )!);
    }
    if (orderId) conditions.push(eq(inventoryMovements.orderId, orderId));
    if (params.startDate) {
        conditions.push(sql`CAST(${inventoryMovements.createdAt} AS INTEGER) >= ${Math.floor(params.startDate.getTime() / 1000)}`);
    }
    if (params.endDate) {
        conditions.push(sql`CAST(${inventoryMovements.createdAt} AS INTEGER) <= ${Math.floor(params.endDate.getTime() / 1000)}`);
    }
    if (params.cursor) {
        const cursor = decodeInventoryMovementCursor(params.cursor);
        conditions.push(sql`(
            CAST(${inventoryMovements.createdAt} AS INTEGER) < ${cursor.createdAt}
            OR (
                CAST(${inventoryMovements.createdAt} AS INTEGER) = ${cursor.createdAt}
                AND ${inventoryMovements.id} < ${cursor.id}
            )
        )`);
    }

    const rows = await db
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
            actorDisplayName: adminUsers.name,
            ledgerVersion: inventoryMovements.ledgerVersion,
            pool: inventoryMovements.pool,
            reservationGeneration: inventoryMovements.reservationGeneration,
            stockVersionBefore: inventoryMovements.stockVersionBefore,
            stockVersionAfter: inventoryMovements.stockVersionAfter,
            stockDelta: inventoryMovements.stockDelta,
            previousReservedStock: inventoryMovements.previousReservedStock,
            newReservedStock: inventoryMovements.newReservedStock,
            reservedStockDelta: inventoryMovements.reservedStockDelta,
            previousPreorderStock: inventoryMovements.previousPreorderStock,
            newPreorderStock: inventoryMovements.newPreorderStock,
            preorderStockDelta: inventoryMovements.preorderStockDelta,
            createdAt: inventoryMovements.createdAt,
            variantSku: productVariants.sku,
            productName: products.name,
        })
        .from(inventoryMovements)
        .leftJoin(productVariants, eq(productVariants.id, inventoryMovements.variantId))
        .leftJoin(products, eq(products.id, productVariants.productId))
        .leftJoin(adminUsers, eq(adminUsers.id, inventoryMovements.createdBy))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(inventoryMovements.createdAt), desc(inventoryMovements.id))
        .limit(params.limit + 1)
        .all();

    const hasMore = rows.length > params.limit;
    const pageRows = rows.slice(0, params.limit);
    const movements = pageRows.map(({ actorDisplayName, ...row }) => ({
        ...row,
        actorName: row.createdBy ? actorDisplayName ?? "Former admin" : "System",
        actorType: row.createdBy
            ? actorDisplayName
                ? "admin" as const
                : "former_admin" as const
            : "system" as const,
    }));
    const last = pageRows.at(-1);

    return {
        movements,
        pageInfo: {
            limit: params.limit,
            hasMore,
            nextCursor: hasMore && last
                ? encodeInventoryMovementCursor({
                    createdAt: movementTimestampSeconds(last.createdAt),
                    id: last.id,
                })
                : null,
        },
    };
}

export async function getInventoryLedgerHealth(db: Database) {
    const result = await db.select({
        legacyRows: sql<number>`COALESCE(SUM(CASE WHEN ${inventoryMovements.ledgerVersion} = 1 THEN 1 ELSE 0 END), 0)`,
        v2Rows: sql<number>`COALESCE(SUM(CASE WHEN ${inventoryMovements.ledgerVersion} = 2 THEN 1 ELSE 0 END), 0)`,
        v2Variants: sql<number>`COUNT(DISTINCT CASE WHEN ${inventoryMovements.ledgerVersion} = 2 THEN ${inventoryMovements.variantId} END)`,
        invalidV2Rows: sql<number>`COALESCE(SUM(CASE WHEN ${inventoryMovements.ledgerVersion} = 2 AND (
            ${inventoryMovements.pool} IS NULL
            OR ${inventoryMovements.pool} NOT IN ('regular', 'preorder', 'backorder')
            OR ${inventoryMovements.stockVersionBefore} IS NULL
            OR ${inventoryMovements.stockVersionAfter} <> ${inventoryMovements.stockVersionBefore} + 1
            OR ${inventoryMovements.stockDelta} IS NULL
            OR ${inventoryMovements.previousReservedStock} IS NULL
            OR ${inventoryMovements.newReservedStock} IS NULL
            OR ${inventoryMovements.reservedStockDelta} IS NULL
            OR ${inventoryMovements.previousPreorderStock} IS NULL
            OR ${inventoryMovements.newPreorderStock} IS NULL
            OR ${inventoryMovements.preorderStockDelta} IS NULL
            OR ${inventoryMovements.newStock} - ${inventoryMovements.previousStock} <> ${inventoryMovements.stockDelta}
            OR ${inventoryMovements.newReservedStock} - ${inventoryMovements.previousReservedStock} <> ${inventoryMovements.reservedStockDelta}
            OR ${inventoryMovements.newPreorderStock} - ${inventoryMovements.previousPreorderStock} <> ${inventoryMovements.preorderStockDelta}
        ) THEN 1 ELSE 0 END), 0)`,
    }).from(inventoryMovements).get();

    return result ?? { legacyRows: 0, v2Rows: 0, v2Variants: 0, invalidV2Rows: 0 };
}

export async function getInventoryOverview(db: Database, params: {
    section: string;
    search: string;
    status: string;
    page: number;
    limit: number;
    alertStatus?: string;
    movementType?: string;
    movementOrderId?: string;
    movementStartDate?: Date;
    movementEndDate?: Date;
    movementCursor?: string;
    movementHealthOnly?: boolean;
    sort?: string;
    order?: string;
}) {
    const { section, search, status, page, limit, alertStatus, movementType, sort, order } = params;

    if (!ALLOWED_INVENTORY_SECTIONS.has(section)) {
        throw new ValidationError("Invalid section parameter");
    }
    if (!ALLOWED_INVENTORY_STATUSES.has(status)) {
        throw new ValidationError("Invalid inventory status parameter");
    }
    if (alertStatus && !ALLOWED_ALERT_STATUSES.has(alertStatus)) {
        throw new ValidationError("Invalid alert status parameter");
    }
    if (movementType && !ALLOWED_MOVEMENT_TYPES.has(movementType)) {
        throw new ValidationError("Invalid movement type parameter");
    }
    if (sort && !ALLOWED_INVENTORY_SORTS.has(sort)) {
        throw new ValidationError("Invalid inventory sort parameter");
    }
    if (order && !ALLOWED_SORT_ORDERS.has(order)) {
        throw new ValidationError("Invalid inventory sort order parameter");
    }
    if (!Number.isSafeInteger(page) || page < 1) {
        throw new ValidationError("Inventory page must be a positive safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new ValidationError("Inventory page size must be between 1 and 100");
    }
    if (search.length > 120) {
        throw new ValidationError("Inventory search must be at most 120 characters");
    }
    const offset = (page - 1) * limit;
    if (!Number.isSafeInteger(offset)) {
        throw new ValidationError("Inventory page offset exceeds the safe integer range");
    }

    if (section === "variants") {
        const conditions: (SQL | undefined)[] = [
            isNull(productVariants.deletedAt),
            eq(productVariants.trackInventory, true),
            operationalSkuRowPredicate(),
        ];

        if (status === "low") {
            conditions.push(buildInventoryLowStockCondition());
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
                optionLabel: variantOptionLabelSql(productVariants.id),
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
            .orderBy(orderBy, asc(productVariants.id))
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
                lowStockCount: sql<number>`SUM(CASE WHEN ${buildInventoryLowStockCondition()} THEN 1 ELSE 0 END)`,
            })
            .from(productVariants)
            .where(and(
                isNull(productVariants.deletedAt),
                eq(productVariants.trackInventory, true),
                operationalSkuRowPredicate(),
            ))
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
        if (params.movementHealthOnly) {
            return { ledgerHealth: await getInventoryLedgerHealth(db) };
        }
        return listInventoryMovements(db, {
            search,
            movementType,
            orderId: params.movementOrderId,
            startDate: params.movementStartDate,
            endDate: params.movementEndDate,
            cursor: params.movementCursor,
            limit,
        });
    }

    if (section === "alerts") {
        const aStatus = alertStatus ?? "active";
        const alertConditions: SQL[] = [];
        if (aStatus !== "all") {
            alertConditions.push(eq(productLowStockAlerts.alertStatus, aStatus));
        }
        if (search.trim()) {
            const searchPattern = `%${search.trim()}%`;
            alertConditions.push(or(
                like(productVariants.sku, searchPattern),
                like(products.name, searchPattern),
            )!);
        }
        const alertWhere = alertConditions.length > 0
            ? and(...alertConditions)
            : undefined;

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(productLowStockAlerts)
            .leftJoin(products, eq(products.id, productLowStockAlerts.productId))
            .leftJoin(productVariants, eq(productVariants.id, productLowStockAlerts.variantId))
            .where(alertWhere)
            .get();
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
                createdAt: productLowStockAlerts.createdAt,
                updatedAt: productLowStockAlerts.updatedAt,
                productName: products.name,
                variantSku: productVariants.sku,
                variantLabel: variantOptionLabelSql(productVariants.id),
            })
            .from(productLowStockAlerts)
            .leftJoin(products, eq(products.id, productLowStockAlerts.productId))
            .leftJoin(productVariants, eq(productVariants.id, productLowStockAlerts.variantId))
            .where(alertWhere)
            .orderBy(desc(productLowStockAlerts.updatedAt), desc(productLowStockAlerts.id))
            .limit(limit)
            .offset(offset)
            .all();

        return {
            alerts,
            pagination: {
                page,
                limit,
                total: countResult?.count ?? 0,
                totalPages: Math.ceil((countResult?.count ?? 0) / limit),
            },
        };
    }

    throw new ValidationError("Invalid section parameter");
}

export async function adjustInventory(db: Database, variantId: string, payload: {
    operationKey: string;
    delta: number;
    reason: string;
    notes?: string;
    pool?: string;
}, adminUserId?: string) {
    const parsedPayload = adjustInventorySchema.safeParse(payload);
    if (!parsedPayload.success) {
        throw new ValidationError(
            parsedPayload.error.issues[0]?.message ?? "Invalid stock adjustment",
        );
    }
    const { operationKey, pool, delta, reason, notes } = parsedPayload.data;
    return executeInventoryOperation(db, {
        operationKey,
        operationType: "manual_adjustment",
        variantId,
        pool,
        mode: "relative",
        delta,
        reason,
        ...(notes ? { notes } : {}),
    }, adminUserId);
}
