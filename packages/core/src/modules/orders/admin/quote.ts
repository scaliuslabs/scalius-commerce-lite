// Manual order quotes: SKU resolution, inventory facts and money for staff-created orders.
import type { Database } from "@scalius/database/client";
import { products, productVariants, shippingMethods } from "@scalius/database/schema";
import { toStoreMinor } from "../../settings/store-money";
import { and, sql, eq, inArray, isNull } from "drizzle-orm";
import {
    isAutoFulfillmentType,
    isFulfillmentKind,
    resolveCheckoutFulfilment,
    type DeliveryMethodKind,
    type FulfillmentKind,
    type FulfillmentType,
} from "@scalius/shared/fulfilment";
import {
    parseStoredCustomizationSchema,
    resolveLineProperties,
    serializeOrderLineProperties,
} from "@scalius/shared/line-properties";
import { discountedPriceMinor, fromMinor } from "@scalius/shared/money";
import { storeCurrencyCodeSql, storeCurrencyFromCode } from "../../products/money";
import type { QuoteManualOrderInput } from "../validation";
import { ValidationError } from "@scalius/core/errors";
import { createOrderCurrencySnapshot, type OrderCurrencySnapshot } from "../../payments/order-currency";
import { getCurrencySettings } from "../../settings/site-settings.service";
import { buildStorefrontTaxAllocationLineId, calculateStorefrontTaxQuote } from "../../tax";
import { type TaxQuote } from "../../tax/browser";
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
    fulfillmentKind: FulfillmentKind;
    isGiftCard: boolean;
    /** Raw `products.customization_schema`, resolved per line by the quote. */
    customizationSchema: string | null;
};
type AdminOrderSkuIssueCode =
    | "SKU_REQUIRED"
    | "VARIANT_UNAVAILABLE"
    | "VARIANT_MISMATCH"
    | "PRODUCT_UNAVAILABLE"
    | "PROPERTIES_REQUIRED"
    | "PROPERTIES_INVALID"
    | "FULFILMENT_UNAVAILABLE";

/** The delivery method a manual order uses, as snapshotted on the order. */
export interface ManualOrderDeliveryMethod {
    id: string;
    name: string;
    description: string | null;
    feeMinor: number;
    kind: DeliveryMethodKind;
    pickupAddress: string | null;
    pickupHours: string | null;
}

/** A line the amendment keeps: its agreed price and frozen buyer inputs. */
export interface RetainedManualOrderLine {
    variantId: string | null;
    unitPriceMinor: number;
    fulfillmentType?: string | null;
    properties?: string | null;
    propertiesPriceMinor?: number | null;
    baseUnitPriceMinor?: number | null;
}

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

interface PreparedManualOrderLine extends AdminOrderItemWithInventory<ManualOrderMoneyItem> {
    fulfillmentType: FulfillmentType;
    /** Serialized snapshot for `order_items.properties`; null without inputs. */
    properties: string | null;
    propertiesPriceMinor: number;
    baseUnitPriceMinor: number;
}

interface PreparedManualOrderQuote {
    currency: OrderCurrencySnapshot;
    locationNames: {
        cityName: string | null;
        zoneName: string | null;
        areaName: string | null;
    };
    /** The destination stored and taxed; null when nothing ships. */
    address: { city: string; zone: string; area: string | null } | null;
    trackedItems: PreparedManualOrderLine[];
    allocationLineIds: string[];
    taxQuote: TaxQuote;
    quote: ManualOrderQuote;
    requiresShipping: boolean;
    deliveryMethodKind: DeliveryMethodKind | null;
    deliveryMethod: ManualOrderDeliveryMethod | null;
}

export interface ManualOrderQuoteOptions {
    /**
     * An amendment keeps the order's delivery method: its kind decides the
     * type of new physical lines. `undefined` means "use shippingMethodId".
     */
    fixedDeliveryMethodKind?: DeliveryMethodKind | null;
}

async function loadManualOrderDeliveryMethod(
    db: Database,
    shippingMethodId: string | null | undefined,
): Promise<ManualOrderDeliveryMethod | null> {
    if (!shippingMethodId) return null;
    const row = await db.select({
        id: shippingMethods.id,
        name: shippingMethods.name,
        description: shippingMethods.description,
        feeMinor: shippingMethods.feeMinor,
        kind: shippingMethods.kind,
        pickupAddress: shippingMethods.pickupAddress,
        pickupHours: shippingMethods.pickupHours,
    }).from(shippingMethods).where(and(
        eq(shippingMethods.id, shippingMethodId),
        isNull(shippingMethods.deletedAt),
    )).get();
    if (!row) throw new ValidationError("That delivery method no longer exists. Choose another.");
    return {
        ...row,
        kind: row.kind === "pickup" ? "pickup" : "delivery",
        pickupAddress: row.pickupAddress?.trim() || null,
        pickupHours: row.pickupHours?.trim() || null,
    };
}

function resolveManualOrderLineProperties(
    items: ReadonlyArray<AdminOrderItemWithInventory<ManualOrderMoneyItem & { properties?: unknown; orderItemId?: string | null }>>,
    retainedLines: ReadonlyMap<string, RetainedManualOrderLine> | undefined,
) {
    const issues: AdminOrderSkuIssue[] = [];
    const lines = items.map((item, index) => {
        const retained = item.orderItemId ? retainedLines?.get(item.orderItemId) : undefined;
        if (retained && retained.variantId === item.variantId) {
            // A kept line keeps the price and buyer inputs the customer agreed to.
            const propertiesPriceMinor = retained.propertiesPriceMinor ?? 0;
            return {
                unitPriceMinor: retained.unitPriceMinor,
                baseUnitPriceMinor: retained.baseUnitPriceMinor ?? retained.unitPriceMinor - propertiesPriceMinor,
                propertiesPriceMinor,
                properties: retained.properties ?? null,
            };
        }
        const schema = parseStoredCustomizationSchema(item.customizationSchema);
        if (!schema.ok) {
            addAdminOrderSkuIssue(issues, item, index, "PRODUCT_UNAVAILABLE",
                "This product's buyer inputs are misconfigured. Fix them on the product first.");
            return null;
        }
        const resolved = resolveLineProperties(schema.schema, item.properties);
        if (!resolved.ok) {
            addAdminOrderSkuIssue(issues, item, index, resolved.code, resolved.code === "PROPERTIES_REQUIRED"
                ? "Fill in the buyer inputs this product requires."
                : "Check the buyer inputs for this item.");
            return null;
        }
        return {
            unitPriceMinor: item.catalogUnitPriceMinor + resolved.propertiesPriceMinor,
            baseUnitPriceMinor: item.catalogUnitPriceMinor,
            propertiesPriceMinor: resolved.propertiesPriceMinor,
            properties: serializeOrderLineProperties(resolved.properties),
        };
    });
    if (issues.length > 0) throwAdminOrderSkuIssues(issues);
    return lines.map((line) => line!);
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
    retainedLines?: ReadonlyMap<string, RetainedManualOrderLine>,
    options: ManualOrderQuoteOptions = {},
): Promise<PreparedManualOrderQuote> {
    const currency = currencyOverride ?? createOrderCurrencySnapshot(
        (await getCurrencySettings(db)).currencyCode,
    );
    // Keep location validation first so a stale/cross-parent destination fails
    // before catalog or tax reads do unnecessary work. A pickup or
    // service-only order sends no address and skips it.
    const submittedCity = data.city?.trim();
    const submittedZone = data.zone?.trim();
    const submittedAddress = submittedCity && submittedZone
        ? { city: submittedCity, zone: submittedZone, area: data.area?.trim() || null }
        : null;
    const submittedLocationNames = submittedAddress
        ? await resolveActiveDeliveryLocationNames(db, submittedAddress)
        : null;
    const resolvedItems = await resolveAdminOrderItemInventory(db, data.items);
    const deliveryMethod = options.fixedDeliveryMethodKind === undefined
        ? await loadManualOrderDeliveryMethod(db, data.shippingMethodId)
        : null;

    // One delivery method per order (Wave A §2.7). A staff order with a
    // physical line and no method picked ships to the address, as before.
    const chosenKind: DeliveryMethodKind | null = options.fixedDeliveryMethodKind !== undefined
        ? options.fixedDeliveryMethodKind
        : deliveryMethod?.kind ?? "delivery";
    const plan = resolveCheckoutFulfilment(resolvedItems.map((item) => ({
        fulfillmentKind: item.fulfillmentKind,
        isGiftCard: item.isGiftCard,
    })), chosenKind);
    if (!plan.ok) {
        throw new ValidationError(plan.issue === "DELIVERY_METHOD_REQUIRED"
            ? "This order has no delivery method, so it can't take items that ship. Create a new order for them."
            : "Add at least one sellable item.");
    }
    // Staff orders are cash on delivery; digital and gift-card lines fulfil
    // automatically and have no fulfiller until Wave B, so they fail closed.
    const unavailable: AdminOrderSkuIssue[] = [];
    plan.lineTypes.forEach((type, index) => {
        if (isAutoFulfillmentType(type)) {
            addAdminOrderSkuIssue(unavailable, resolvedItems[index]!, index, "FULFILMENT_UNAVAILABLE",
                "Digital items and gift cards can't be added to an order yet.");
        }
    });
    if (unavailable.length > 0) throwAdminOrderSkuIssues(unavailable);

    let address: PreparedManualOrderQuote["address"] = null;
    let locationNames: PreparedManualOrderQuote["locationNames"] = { cityName: null, zoneName: null, areaName: null };
    if (plan.requiresShipping) {
        if (!submittedAddress || !submittedLocationNames) {
            throw new ValidationError("Choose the delivery city and thana, or a pickup method.");
        }
        address = submittedAddress;
        locationNames = submittedLocationNames;
    }

    const lineProperties = resolveManualOrderLineProperties(
        resolvedItems.map((item, index) => ({
            ...item,
            orderItemId: (data.items[index] as { orderItemId?: string | null } | undefined)?.orderItemId ?? null,
            unitPriceMinor: item.catalogUnitPriceMinor,
        })),
        retainedLines,
    );
    const trackedItems: PreparedManualOrderLine[] = resolvedItems.map((item, index) => ({
        ...item,
        ...lineProperties[index]!,
        fulfillmentType: plan.lineTypes[index]!,
    }));
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
        // No address (pickup, service): only store-wide rates apply.
        destination: {
            city: address?.city ?? null,
            zone: address?.zone ?? null,
            area: address?.area ?? null,
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
        address,
        trackedItems,
        allocationLineIds,
        taxQuote,
        quote: projectManualOrderQuote(taxQuote, trackedItems),
        requiresShipping: plan.requiresShipping,
        deliveryMethodKind: plan.deliveryMethodKind,
        deliveryMethod,
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
            fulfillmentKind: productVariants.fulfillmentKind,
            isGiftCard: products.isGiftCard,
            customizationSchema: products.customizationSchema,
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
            fulfillmentKind: isFulfillmentKind(sku.fulfillmentKind) ? sku.fulfillmentKind : "physical",
            isGiftCard: sku.isGiftCard === true,
            customizationSchema: sku.customizationSchema,
        });
    });

    if (issues.length > 0) {
        throwAdminOrderSkuIssues(issues);
    }

    return resolvedItems;
}
