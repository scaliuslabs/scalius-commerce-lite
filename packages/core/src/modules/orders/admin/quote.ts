// Manual order quotes: SKU resolution, inventory facts and money for staff-created orders.
import type { Database } from "@scalius/database/client";
import { products, productVariants } from "@scalius/database/schema";
import { toStoreMinor } from "../../settings/store-money";
import { sql, eq, inArray } from "drizzle-orm";
import { discountedPriceMinor, fromMinor } from "@scalius/shared/money";
import { storeCurrencyCodeSql, storeCurrencyFromCode } from "../../products/money";
import type { QuoteManualOrderInput } from "../validation";
import { ValidationError } from "@scalius/core/errors";
import { createOrderCurrencySnapshot, type OrderCurrencySnapshot } from "../../payments/order-currency";
import { getCurrencySettings } from "../../settings/site-settings.service";
import { buildStorefrontTaxAllocationLineId, calculateStorefrontTaxQuote, type TaxQuote } from "../../tax";
import { variantOptionLabelSql } from "../../products/option-model";
import { loadProductMediaProjections, resolveSkuImageRepresentation } from "../../products/media";
import { resolveActiveDeliveryLocationNames } from "../../delivery/location-validation";

type AdminOrderSkuItem = { productId: string; variantId: string | null };
type AdminOrderItemWithInventory<T extends AdminOrderSkuItem> = T & {
    variantId: string;
    inventoryTracked: boolean;
    productName: string;
    variantLabel: string | null;
    productImageMediaId: string | null;
    taxClassId: string | null;
    catalogUnitPriceMinor: number;
};
type AdminOrderSkuIssueCode =
    | "SKU_REQUIRED"
    | "VARIANT_UNAVAILABLE"
    | "VARIANT_MISMATCH"
    | "PRODUCT_UNAVAILABLE";

interface ManualOrderMoneyItem {
    productId: string;
    variantId: string | null;
    quantity: number;
    unitPriceMinor: number;
}

/** Order totals in integer minor units: total = subtotal + shipping − discount. */
function calculateManualOrderMoney(
    items: ManualOrderMoneyItem[],
    shippingMinor: number,
    discountMinor: number,
    currency: OrderCurrencySnapshot,
) {
    const subtotalAmountMinor = items.reduce(
        (sum, item) => sum + item.unitPriceMinor * item.quantity,
        0,
    );
    if (discountMinor > subtotalAmountMinor) {
        throw new ValidationError(
            "Discount amount cannot exceed the manual order subtotal.",
            {
                reason: "MANUAL_ORDER_DISCOUNT_EXCEEDS_SUBTOTAL",
                maximumDiscountAmountMinor: subtotalAmountMinor,
                currencyCode: currency.code,
                decimalPlaces: currency.decimalPlaces,
            },
        );
    }
    return {
        subtotalAmountMinor,
        shippingAmountMinor: shippingMinor,
        discountAmountMinor: discountMinor,
        totalAmountMinor: subtotalAmountMinor + shippingMinor - discountMinor,
    };
}

export interface ManualOrderQuote {
    currencyCode: string;
    decimalPlaces: number;
    subtotalAmount: number;
    shippingAmount: number;
    discountAmount: number;
    taxAmount: number;
    totalAmount: number;
    taxLabel: string;
    pricesIncludeTax: boolean;
    taxEnabled: boolean;
    settingsVersion: number;
    lines: Array<{
        index: number;
        productId: string;
        variantId: string;
        quantity: number;
        unitPrice: number;
        lineSubtotal: number;
    }>;
}

interface PreparedManualOrderQuote {
    currency: OrderCurrencySnapshot;
    locationNames: {
        cityName: string;
        zoneName: string;
        areaName: string | null;
    };
    trackedItems: Array<AdminOrderItemWithInventory<ManualOrderMoneyItem>>;
    allocationLineIds: string[];
    taxQuote: TaxQuote;
    quote: ManualOrderQuote;
}

function projectManualOrderQuote(
    taxQuote: TaxQuote,
    trackedItems: PreparedManualOrderQuote["trackedItems"],
): ManualOrderQuote {
    const amount = (value: number) => fromMinor(value, taxQuote.decimalPlaces);
    return {
        currencyCode: taxQuote.currencyCode,
        decimalPlaces: taxQuote.decimalPlaces,
        subtotalAmount: amount(taxQuote.subtotalMinor),
        shippingAmount: amount(taxQuote.shippingMinor),
        discountAmount: amount(taxQuote.discountMinor),
        taxAmount: amount(taxQuote.taxMinor),
        totalAmount: amount(taxQuote.totalMinor),
        taxLabel: taxQuote.displayLabel,
        pricesIncludeTax: taxQuote.pricesIncludeTax,
        taxEnabled: taxQuote.enabled,
        settingsVersion: taxQuote.settingsVersion,
        lines: trackedItems.map((item, index) => ({
            index,
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            unitPrice: amount(item.unitPriceMinor),
            lineSubtotal: amount(taxQuote.lines[index]?.grossAmountMinor ?? 0),
        })),
    };
}

export async function prepareManualOrderQuote(
    db: Database,
    data: QuoteManualOrderInput,
    currencyOverride?: OrderCurrencySnapshot,
    retainedLines?: ReadonlyMap<string, { variantId: string | null; unitPriceMinor: number }>,
): Promise<PreparedManualOrderQuote> {
    const currency = currencyOverride ?? createOrderCurrencySnapshot(
        (await getCurrencySettings(db)).currencyCode,
    );
    // Keep location validation first so a stale/cross-parent destination fails
    // before catalog or tax reads do unnecessary work.
    const locationNames = await resolveActiveDeliveryLocationNames(db, data);
    const resolvedItems = await resolveAdminOrderItemInventory(db, data.items);
    const trackedItems = resolvedItems.map((item, index) => {
        const orderItemId = (data.items[index] as { orderItemId?: string | null } | undefined)?.orderItemId;
        const retained = orderItemId ? retainedLines?.get(orderItemId) : undefined;
        return {
            ...item,
            unitPriceMinor: retained && retained.variantId === item.variantId
                ? retained.unitPriceMinor
                : item.catalogUnitPriceMinor,
        };
    });
    const money = calculateManualOrderMoney(
        trackedItems,
        toStoreMinor(data.shippingCharge, currency),
        toStoreMinor(data.discountAmount ?? 0, currency),
        currency,
    );
    const allocationLineIds = trackedItems.map((item, index) =>
        buildStorefrontTaxAllocationLineId(index, item.variantId),
    );
    const taxQuote = await calculateStorefrontTaxQuote(db, {
        destination: {
            city: data.city,
            zone: data.zone,
            area: data.area,
            ...locationNames,
        },
        lines: trackedItems.map((item, index) => ({
            lineId: allocationLineIds[index]!,
            productId: item.productId,
            variantId: item.variantId,
            unitPriceMinor: item.unitPriceMinor,
            quantity: item.quantity,
            taxClassId: item.taxClassId,
        })),
        shippingMinor: money.shippingAmountMinor,
        discountMinor: money.discountAmountMinor,
        currency: {
            code: currency.code,
            decimalPlaces: currency.decimalPlaces,
        },
    });

    return {
        currency,
        locationNames,
        trackedItems,
        allocationLineIds,
        taxQuote,
        quote: projectManualOrderQuote(taxQuote, trackedItems),
    };
}

export async function quoteManualOrder(
    db: Database,
    data: QuoteManualOrderInput,
): Promise<ManualOrderQuote> {
    return (await prepareManualOrderQuote(db, data)).quote;
}

interface AdminOrderSkuIssue {
    index: number;
    productId: string;
    variantId: string | null;
    code: AdminOrderSkuIssueCode;
    message: string;
}

function throwAdminOrderSkuIssues(issues: AdminOrderSkuIssue[]): never {
    throw new ValidationError("Some manual order items need attention.", { itemIssues: issues });
}

function addAdminOrderSkuIssue(
    issues: AdminOrderSkuIssue[],
    item: AdminOrderSkuItem,
    index: number,
    code: AdminOrderSkuIssueCode,
    message: string,
) {
    issues.push({
        index,
        productId: item.productId,
        variantId: item.variantId ?? null,
        code,
        message,
    });
}

function assertAdminOrderItemsUseSkus(items: AdminOrderSkuItem[]) {
    const issues: AdminOrderSkuIssue[] = [];
    items.forEach((item, index) => {
        if (!item.variantId) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "SKU_REQUIRED",
                "Select a product SKU before saving the order.",
            );
        }
    });

    if (issues.length > 0) {
        throwAdminOrderSkuIssues(issues);
    }
}

export async function resolveAdminOrderItemInventory<T extends AdminOrderSkuItem>(
    db: Database,
    items: T[],
): Promise<Array<AdminOrderItemWithInventory<T>>> {
    assertAdminOrderItemsUseSkus(items);

    const variantIds = [...new Set(items.map((item) => item.variantId).filter((id): id is string => Boolean(id)))];
    if (variantIds.length === 0) return [];

    const rows = await db
        .select({
            id: productVariants.id,
            productId: productVariants.productId,
            trackInventory: productVariants.trackInventory,
            imageId: productVariants.imageId,
            productName: products.name,
            productDiscountType: products.discountType,
            productDiscountBps: products.discountBps,
            productDiscountAmountMinor: products.discountAmountMinor,
            storeCurrencyCode: storeCurrencyCodeSql(),
            variantPriceMinor: productVariants.priceMinor,
            variantDiscountType: productVariants.discountType,
            variantDiscountBps: productVariants.discountBps,
            variantDiscountAmountMinor: productVariants.discountAmountMinor,
            taxClassId: sql<string | null>`coalesce(${productVariants.taxClassId}, ${products.taxClassId})`,
            variantLabel: variantOptionLabelSql(productVariants.id),
            variantDeletedAt: productVariants.deletedAt,
            productActive: products.isActive,
            productDeletedAt: products.deletedAt,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(inArray(productVariants.id, variantIds));

    const skuByVariantId = new Map(rows.map((row) => [row.id, row]));
    const mediaByProduct = await loadProductMediaProjections(
        db,
        [...new Set(rows.map((row) => row.productId))],
    );
    const issues: AdminOrderSkuIssue[] = [];
    const resolvedItems: Array<AdminOrderItemWithInventory<T>> = [];

    items.forEach((item, index) => {
        const variantId = item.variantId!;
        const sku = skuByVariantId.get(variantId);
        if (!sku) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "VARIANT_UNAVAILABLE",
                "Selected SKU is no longer available.",
            );
            return;
        }
        if (sku.productId !== item.productId) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "VARIANT_MISMATCH",
                "Selected SKU does not belong to this product.",
            );
            return;
        }
        if (sku.variantDeletedAt) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "VARIANT_UNAVAILABLE",
                "Selected SKU has been deleted.",
            );
            return;
        }
        if (!sku.productActive || sku.productDeletedAt) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "PRODUCT_UNAVAILABLE",
                "Selected product is not active.",
            );
            return;
        }

        const variantHasDiscount =
            (sku.variantDiscountType === "percentage" && sku.variantDiscountBps > 0)
            || (sku.variantDiscountType === "flat" && sku.variantDiscountAmountMinor > 0);
        const catalogUnitPriceMinor = variantHasDiscount
            ? discountedPriceMinor(
                sku.variantPriceMinor,
                sku.variantDiscountType,
                sku.variantDiscountBps,
                sku.variantDiscountAmountMinor,
                storeCurrencyFromCode(sku.storeCurrencyCode),
            )
            : discountedPriceMinor(
                sku.variantPriceMinor,
                sku.productDiscountType,
                sku.productDiscountBps,
                sku.productDiscountAmountMinor,
                storeCurrencyFromCode(sku.storeCurrencyCode),
            );

        resolvedItems.push({
            ...item,
            variantId,
            inventoryTracked: sku.trackInventory,
            productName: sku.productName,
            variantLabel: sku.variantLabel,
            productImageMediaId: resolveSkuImageRepresentation(
                mediaByProduct.get(sku.productId) ?? [],
                sku.imageId,
            )?.mediaId ?? null,
            taxClassId: sku.taxClassId,
            catalogUnitPriceMinor,
        });
    });

    if (issues.length > 0) {
        throwAdminOrderSkuIssues(issues);
    }

    return resolvedItems;
}
