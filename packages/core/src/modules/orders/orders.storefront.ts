// src/modules/orders/orders.storefront.ts
// Storefront order creation — validates and prepares orders for queue dispatch.

import { safeBatch, type Database } from "@scalius/database/client";
import {
    DEFAULT_CURRENCY,
    getDecimalPlaces,
    normalizeSupportedCurrencyCode,
} from "@scalius/shared/currency";
import { roundPrice } from "@scalius/shared/price-utils";
import {
    buildStorefrontTaxAllocationLineId,
    calculateStorefrontTaxQuote,
    fromMinorUnits,
    toMinorUnits,
    type StorefrontDiscountType,
    type StorefrontTaxAuthoritySnapshot,
} from "../tax";
import {
    evaluateStorefrontPromotionCode,
    resolvePromotionCustomerIdByPhone,
    type AppliedPromotion,
    type PromotionCheckoutSnapshot,
} from "../promotions";
import {
    siteSettings,
    shippingMethods,
    PaymentMethod,
    PaymentStatus,
    OrderStatus,
    FulfillmentStatus,
} from "@scalius/database/schema";
import { nanoid } from "nanoid";

import { eq, and, inArray, isNull } from "drizzle-orm";
import { generateOrderId } from "@scalius/shared/order-utils";
import { ValidationError } from "@scalius/core/errors";
import type {
    CreateStorefrontOrderCustomerIdentity,
    CreateStorefrontOrderIdentity,
    CreateStorefrontOrderInput,
    CreateStorefrontOrderResult,
    StorefrontOrderShippingMethodSnapshot,
} from "./orders.types";
import {
    isTrustedStorefrontCartValidationResult,
    validateStorefrontCartItems,
    type StorefrontCartValidationResult,
} from "./cart-validation";
import {
    resolveActiveDeliveryLocationNamesFromRows,
    selectActiveDeliveryLocationRows,
    type ActiveDeliveryLocationRow,
} from "./delivery-location-validation";
import { MAX_ORDER_LINE_ITEMS } from "./orders.validation";

export interface StorefrontShippingMethodRow {
    id: string;
    name: string;
    description: string | null;
    fee: number;
    isActive: boolean;
    deletedAt: Date | number | null;
}

export interface StorefrontDeliveryPreflightInput {
    city: string;
    zone: string;
    area?: string | null;
    shippingMethodId?: string | null;
    currencyCode?: string | null;
}

export interface StorefrontDeliveryPreflightResult {
    shippingCharge: number;
    shippingMethod: StorefrontOrderShippingMethodSnapshot;
    cityName: string;
    zoneName: string;
    areaName: string | null;
}

export interface StorefrontCheckoutPolicySnapshot {
    partialPaymentEnabled: boolean;
    authorityRevision?: number;
    orderCreatedNotificationEnabled?: boolean;
    metaPurchaseEnabled?: boolean;
}

const STOREFRONT_DELIVERY_PREFLIGHT_RESULT_PROOF = Symbol("scalius.storefrontDeliveryPreflightResult");
const STOREFRONT_CHECKOUT_POLICY_SNAPSHOT_PROOF = Symbol("scalius.storefrontCheckoutPolicySnapshot");

function markTrustedStorefrontDeliveryPreflightResult(
    result: StorefrontDeliveryPreflightResult,
): StorefrontDeliveryPreflightResult {
    Object.defineProperty(result, STOREFRONT_DELIVERY_PREFLIGHT_RESULT_PROOF, {
        value: true,
        enumerable: false,
    });
    return result;
}

function buildPromotionTaxAllocation(applied: AppliedPromotion) {
    const lineAmounts = new Map<string, number>();
    let shippingMinor = 0;
    for (const allocation of applied.allocations) {
        if (allocation.target === "shipping") {
            shippingMinor += allocation.discountAmountMinor;
            continue;
        }
        if (!allocation.lineId) {
            throw new ValidationError("Promotion line allocation is missing its checkout line.");
        }
        lineAmounts.set(
            allocation.lineId,
            (lineAmounts.get(allocation.lineId) ?? 0) + allocation.discountAmountMinor,
        );
    }
    return {
        lines: [...lineAmounts.entries()].map(([lineId, amountMinor]) => ({ lineId, amountMinor })),
        shippingMinor,
    };
}

export function isTrustedStorefrontDeliveryPreflightResult(
    result: StorefrontDeliveryPreflightResult | undefined,
): result is StorefrontDeliveryPreflightResult {
    return Boolean(result && Reflect.get(result, STOREFRONT_DELIVERY_PREFLIGHT_RESULT_PROOF) === true);
}

export function createTrustedStorefrontCheckoutPolicySnapshot(
    snapshot: StorefrontCheckoutPolicySnapshot,
): StorefrontCheckoutPolicySnapshot {
    const trustedSnapshot = { ...snapshot };
    Object.defineProperty(trustedSnapshot, STOREFRONT_CHECKOUT_POLICY_SNAPSHOT_PROOF, {
        value: true,
        enumerable: false,
    });
    return trustedSnapshot;
}

export function isTrustedStorefrontCheckoutPolicySnapshot(
    snapshot: StorefrontCheckoutPolicySnapshot | undefined,
): snapshot is StorefrontCheckoutPolicySnapshot {
    return Boolean(snapshot && Reflect.get(snapshot, STOREFRONT_CHECKOUT_POLICY_SNAPSHOT_PROOF) === true);
}

export function selectActiveStorefrontShippingMethodRows(
    storefrontDb: Database,
    shippingMethodId: string | null | undefined,
) {
    return selectActiveStorefrontShippingMethodRowsByIds(
        storefrontDb,
        shippingMethodId ? [shippingMethodId] : [],
    );
}

export function selectActiveStorefrontShippingMethodRowsByIds(
    storefrontDb: Database,
    rawShippingMethodIds: readonly string[],
) {
    const shippingMethodIds = [...new Set(
        rawShippingMethodIds.map((id) => id.trim()).filter(Boolean),
    )];
    const query = storefrontDb
        .select({
            id: shippingMethods.id,
            name: shippingMethods.name,
            description: shippingMethods.description,
            fee: shippingMethods.fee,
            isActive: shippingMethods.isActive,
            deletedAt: shippingMethods.deletedAt,
        })
        .from(shippingMethods);
    if (shippingMethodIds.length === 0) return query.limit(0);
    return query.where(
        and(
            inArray(shippingMethods.id, shippingMethodIds),
            eq(shippingMethods.isActive, true),
            isNull(shippingMethods.deletedAt),
        ),
    );
}

export function resolveStorefrontDeliveryPreflightFromRows(
    data: StorefrontDeliveryPreflightInput,
    cartValidation: Pick<StorefrontCartValidationResult, "hasFreeDeliveryProduct">,
    locationRows: readonly ActiveDeliveryLocationRow[],
    shippingMethodRows: readonly StorefrontShippingMethodRow[],
): StorefrontDeliveryPreflightResult {
    const currencyCode = normalizeSupportedCurrencyCode(data.currencyCode) ?? DEFAULT_CURRENCY.code;
    const locationNames = resolveActiveDeliveryLocationNamesFromRows(data, [...locationRows]);

    const shippingMethod = shippingMethodRows[0] ?? null;
    const shippingMethodIsUsable =
        shippingMethod
        && shippingMethod.id === data.shippingMethodId
        && shippingMethod.isActive === true
        && shippingMethod.deletedAt == null;

    if (!shippingMethodIsUsable) {
        throw new ValidationError("A valid active shipping method is required for this order.");
    }

    const methodFee = Number(shippingMethod.fee);
    const methodName = typeof shippingMethod.name === "string"
        ? shippingMethod.name.trim()
        : "";
    const methodDescription = shippingMethod.description == null
        ? null
        : typeof shippingMethod.description === "string"
            ? shippingMethod.description.trim() || null
            : null;
    if (
        !Number.isFinite(methodFee)
        || methodFee < 0
        || !methodName
        || methodName.length > 100
        || (methodDescription?.length ?? 0) > 255
    ) {
        throw new ValidationError("Selected shipping method is misconfigured.");
    }
    const roundedMethodFee = roundPrice(methodFee, currencyCode);
    const shippingFeeWaived = cartValidation.hasFreeDeliveryProduct;
    const shippingCharge = shippingFeeWaived ? 0 : roundedMethodFee;

    return markTrustedStorefrontDeliveryPreflightResult({
        shippingCharge,
        shippingMethod: {
            id: shippingMethod.id,
            name: methodName,
            description: methodDescription,
            baseAmountMinor: toMinorUnits(
                roundedMethodFee,
                getDecimalPlaces(currencyCode),
            ),
            feeWaived: shippingFeeWaived,
        },
        cityName: locationNames.cityName,
        zoneName: locationNames.zoneName,
        areaName: locationNames.areaName,
    });
}

export async function validateStorefrontDeliveryPreflight(
    storefrontDb: Database,
    data: StorefrontDeliveryPreflightInput,
    cartValidation: Pick<StorefrontCartValidationResult, "hasFreeDeliveryProduct">,
): Promise<StorefrontDeliveryPreflightResult> {
    const readBatch = [
        selectActiveDeliveryLocationRows(storefrontDb, data),
        selectActiveStorefrontShippingMethodRows(storefrontDb, data.shippingMethodId),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    const [locationRows, shippingMethodRows] = await storefrontDb.batch(readBatch as any);

    return resolveStorefrontDeliveryPreflightFromRows(
        data,
        cartValidation,
        Array.isArray(locationRows) ? locationRows as ActiveDeliveryLocationRow[] : [],
        Array.isArray(shippingMethodRows) ? shippingMethodRows as StorefrontShippingMethodRow[] : [],
    );
}

/**
 * Validates and prepares a storefront order for synchronous checkout commit.
 * Performs server-side price verification, discount validation, shipping verification,
 * and partial payment checks. Returns the committed order identity plus the prepared commit payload.
 *
 * @param storefrontDb - The D1 database instance (from c.get("db"))
 * @param data - Parsed and validated order input
 * @param requestUrl - The original request URL
 * @param isDiscountValid - Discount validation function (from discounts route)
 * @param calculateDiscountAmount - Discount calculation function (from discounts route)
 */
export async function createStorefrontOrder(
    storefrontDb: Database,
    data: CreateStorefrontOrderInput,
    requestUrl: string,
    isDiscountValid: (
        db: Database,
        code: string,
        total: number,
        items: unknown[],
        customerPhone: string,
        customerId?: string,
    ) => Promise<unknown>,
    calculateDiscountAmount: (
        db: Database,
        discount: unknown,
        total: number,
        items: unknown[],
        shippingCost: number,
        applicableProductIds?: Set<string>,
        hasProductRestrictions?: boolean,
    ) => number | Promise<number>,
    identity?: CreateStorefrontOrderIdentity,
    prevalidatedCart?: StorefrontCartValidationResult,
    prevalidatedDelivery?: StorefrontDeliveryPreflightResult,
    customerIdentity?: CreateStorefrontOrderCustomerIdentity,
    requestCurrency: { code: string; decimalPlaces: number } = {
        code: DEFAULT_CURRENCY.code,
        decimalPlaces: DEFAULT_CURRENCY.decimalPlaces,
    },
    promotionAuthority: {
        evaluateCode: typeof evaluateStorefrontPromotionCode;
        resolveCustomerIdByPhone: typeof resolvePromotionCustomerIdByPhone;
    } = {
        evaluateCode: evaluateStorefrontPromotionCode,
        resolveCustomerIdByPhone: resolvePromotionCustomerIdByPhone,
    },
    checkoutPolicySnapshot?: StorefrontCheckoutPolicySnapshot,
    taxAuthoritySnapshot?: StorefrontTaxAuthoritySnapshot,
): Promise<CreateStorefrontOrderResult> {
    if (data.items.length > MAX_ORDER_LINE_ITEMS) {
        throw new ValidationError(
            `Checkout supports at most ${MAX_ORDER_LINE_ITEMS} line items.`,
        );
    }

    if (prevalidatedCart && !isTrustedStorefrontCartValidationResult(prevalidatedCart)) {
        throw new ValidationError("Checkout cart validation could not be trusted. Please retry checkout.");
    }

    const cartValidation = prevalidatedCart ?? await validateStorefrontCartItems(
        storefrontDb,
        data.items.map((item) => ({
            cartKey: item.cartKey,
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            price: item.price,
            productName: item.productName,
            variantLabel: item.variantLabel,
        })),
        { inventoryPool: data.inventoryPool },
    );

    if (!cartValidation.valid) {
        throw new ValidationError("Some items in your cart need attention.", {
            itemIssues: cartValidation.issues,
        });
    }
    if (
        cartValidation.items.length !== data.items.length ||
        data.items.some((_, index) => !cartValidation.items.some((item) => item.index === index))
    ) {
        throw new ValidationError("Checkout cart validation returned an incomplete item set. Please retry checkout.");
    }

    // ------------------------------------------------------------------
    // 1. Batched Reads
    // ------------------------------------------------------------------
    const normalizedDiscountCode = data.discountCode?.trim().toUpperCase();
    if (prevalidatedDelivery && !isTrustedStorefrontDeliveryPreflightResult(prevalidatedDelivery)) {
        throw new ValidationError("Checkout delivery validation could not be trusted. Please retry checkout.");
    }

    const deliveryPreflight = prevalidatedDelivery ?? await validateStorefrontDeliveryPreflight(
        storefrontDb,
        {
            city: data.city,
            zone: data.zone,
            area: data.area,
            shippingMethodId: data.shippingMethodId,
        },
        cartValidation,
    );

    if (
        checkoutPolicySnapshot
        && !isTrustedStorefrontCheckoutPolicySnapshot(checkoutPolicySnapshot)
    ) {
        throw new ValidationError("Checkout policy validation could not be trusted. Please retry checkout.");
    }

    let fallbackSettings: Record<string, unknown> | null = null;
    if (!checkoutPolicySnapshot) {
        // Compatibility for direct Core callers. The API route supplies its
        // already-fresh policy snapshot and skips this extra database roundtrip.
        const [settingsList = []] = await safeBatch(storefrontDb, [
            storefrontDb.select().from(siteSettings).limit(1),
        ]);
        fallbackSettings = settingsList.length > 0
            ? settingsList[0] as Record<string, unknown>
            : null;
    }

    const accountOwnerCustomer = customerIdentity ? { id: customerIdentity.customerId } : null;

    const serverItemTotal = cartValidation.subtotal;
    const validatedItemByIndex = new Map(cartValidation.items.map((item) => [item.index, item]));
    const verifiedShippingCharge = deliveryPreflight.shippingCharge;

    // Stable allocation identities are established before either promotion or
    // tax evaluation. Commit-time re-evaluation uses these same ids.
    const preparedItems = data.items.map((item, idx) => {
        const validatedItem = validatedItemByIndex.get(idx)!;
        return {
            id: `item_${nanoid()}`,
            taxAllocationLineId: buildStorefrontTaxAllocationLineId(idx, validatedItem.variantId),
            cartKey: validatedItem.cartKey ?? item.cartKey ?? null,
            productId: validatedItem.productId,
            variantId: validatedItem.variantId,
            quantity: validatedItem.quantity,
            price: validatedItem.unitPrice,
            productName: validatedItem.productName,
            variantLabel: validatedItem.variantLabel,
            inventoryTracked: validatedItem.inventoryTracked,
            taxClassId: validatedItem.taxClassId,
            productImageMediaId: validatedItem.productImageMediaId,
        };
    });

    // ------------------------------------------------------------------
    // DISCOUNTS VERIFICATION
    // ------------------------------------------------------------------
    let verifiedDiscountAmount = 0;
    let appliedDiscountId: string | null = null;
    let discountType: StorefrontDiscountType | null = null;
    let applicableProductIds: Set<string> | undefined;
    let promotionSnapshot: PromotionCheckoutSnapshot | null = null;
    if (normalizedDiscountCode) {
        const discountItems = cartValidation.items.map((item) => ({
            id: item.productId,
            price: item.unitPrice,
            quantity: item.quantity,
            variantId: item.variantId,
        }));
        const promotionCustomerId = accountOwnerCustomer?.id
            ?? await promotionAuthority.resolveCustomerIdByPhone(storefrontDb, data.customerPhone);
        const promotionCart = {
            currencyCode: requestCurrency.code,
            lines: preparedItems.map((item) => ({
                id: item.taxAllocationLineId,
                productId: item.productId,
                variantId: item.variantId,
                unitPriceMinor: toMinorUnits(item.price, requestCurrency.decimalPlaces),
                quantity: item.quantity,
            })),
            shippingAmountMinor: toMinorUnits(verifiedShippingCharge, requestCurrency.decimalPlaces),
            evaluatedAtEpochSeconds: Math.floor(Date.now() / 1_000),
        };
        const promotionResolution = await promotionAuthority.evaluateCode(storefrontDb, {
            code: normalizedDiscountCode,
            cart: promotionCart,
            customerId: promotionCustomerId,
        });
        if (promotionResolution.matched) {
            if (!promotionResolution.valid) {
                throw new ValidationError(promotionResolution.message);
            }
            verifiedDiscountAmount = fromMinorUnits(
                promotionResolution.evaluation.applied.totalDiscountMinor,
                requestCurrency.decimalPlaces,
            );
            const { evaluatedAtEpochSeconds: _evaluatedAtEpochSeconds, ...commitCart } = promotionCart;
            promotionSnapshot = {
                cart: {
                    ...commitCart,
                    submittedCodes: [normalizedDiscountCode],
                },
                applied: promotionResolution.evaluation.applied,
            };
        } else {
            // Explicit compatibility boundary: globally unique typed codes are
            // always handled above; only an unknown typed code may fall back to
            // the legacy discount authority.
            const validationResponse = await isDiscountValid(
                storefrontDb,
                normalizedDiscountCode,
                serverItemTotal,
                discountItems,
                data.customerPhone,
                accountOwnerCustomer?.id,
            );

            const validResult = validationResponse as Record<string, unknown> | null;
            if (validResult && validResult.valid && validResult.discount) {
            const validatedDiscount = validResult.discount as {
                id?: string;
                type?: StorefrontDiscountType;
            };
            if (
                typeof validatedDiscount.id !== "string" ||
                !validatedDiscount.id.trim() ||
                !["amount_off_products", "amount_off_order", "free_shipping"].includes(
                    validatedDiscount.type ?? "",
                )
            ) {
                throw new ValidationError("The discount configuration is invalid.");
            }
            appliedDiscountId = validatedDiscount.id;
            discountType = validatedDiscount.type!;
            let hasProductRestrictions = false;
            if (validatedDiscount.type === "amount_off_products") {
                hasProductRestrictions = validResult.hasProductRestrictions === true;
                if (
                    !hasProductRestrictions ||
                    !(validResult.applicableProductIds instanceof Set)
                ) {
                    throw new ValidationError("The product discount scope could not be verified.");
                }
                applicableProductIds = validResult.applicableProductIds as Set<string>;
            }
            verifiedDiscountAmount = await calculateDiscountAmount(
                storefrontDb,
                validResult.discount,
                serverItemTotal + verifiedShippingCharge,
                discountItems,
                verifiedShippingCharge,
                applicableProductIds,
                hasProductRestrictions,
            );
            } else {
                const rejectionReason =
                    typeof validResult?.error === "string" &&
                    validResult.error.length > 0 &&
                    validResult.error.length <= 200
                        ? validResult.error
                        : `Discount code ${normalizedDiscountCode} is invalid or expired.`;
                throw new ValidationError(rejectionReason);
            }
        }
    }
    const taxQuoteInput = {
        destination: {
            city: data.city,
            zone: data.zone,
            area: data.area,
            cityName: deliveryPreflight.cityName,
            zoneName: deliveryPreflight.zoneName,
            areaName: deliveryPreflight.areaName,
        },
        lines: preparedItems.map((item) => ({
            lineId: item.taxAllocationLineId,
            productId: item.productId,
            variantId: item.variantId,
            unitPrice: item.price,
            quantity: item.quantity,
            taxClassId: item.taxClassId,
        })),
        shippingAmount: verifiedShippingCharge,
        discountAmount: verifiedDiscountAmount,
        discountType,
        applicableProductIds: applicableProductIds ? [...applicableProductIds] : undefined,
        promotionDiscountAllocation: promotionSnapshot
            ? buildPromotionTaxAllocation(promotionSnapshot.applied)
            : undefined,
        currency: requestCurrency,
    };
    const taxQuote = taxAuthoritySnapshot
        ? await calculateStorefrontTaxQuote(storefrontDb, taxQuoteInput, taxAuthoritySnapshot)
        : await calculateStorefrontTaxQuote(storefrontDb, taxQuoteInput);
    const normalizedDiscountAmount = fromMinorUnits(taxQuote.discountMinor, taxQuote.decimalPlaces);
    const totalAmount = fromMinorUnits(taxQuote.totalMinor, taxQuote.decimalPlaces);

    // ------------------------------------------------------------------
    // PARTIAL PAYMENT SECURITY CHECK
    // ------------------------------------------------------------------
    const isPartialEnabled = checkoutPolicySnapshot?.partialPaymentEnabled
        ?? (fallbackSettings?.partialPaymentEnabled as boolean)
        ?? false;
    if (isPartialEnabled && data.paymentMethod === PaymentMethod.COD) {
        throw new ValidationError("Advance deposit is required. COD cannot be selected for the full amount directly.");
    }

    // ------------------------------------------------------------------
    // Build Commit Payload
    // ------------------------------------------------------------------
    const orderId = identity?.orderId ?? generateOrderId();
    const checkoutToken = identity?.checkoutToken ?? `chk_${nanoid()}`;

    const commitPayload = {
        checkoutToken,
        checkoutAuthorityRevision: checkoutPolicySnapshot?.authorityRevision ?? null,
        checkoutSideEffects: {
            orderCreatedNotification:
                checkoutPolicySnapshot?.orderCreatedNotificationEnabled ?? true,
            metaPurchase: checkoutPolicySnapshot?.metaPurchaseEnabled ?? true,
        },
        existingCustomer: accountOwnerCustomer,
        orderData: {
            id: orderId,
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            customerEmail: data.customerEmail,
            shippingAddress: data.shippingAddress,
            city: data.city,
            zone: data.zone,
            area: data.area,
            cityName: deliveryPreflight.cityName,
            zoneName: deliveryPreflight.zoneName,
            areaName: deliveryPreflight.areaName,
            notes: data.notes,
            totalAmount,
            shippingCharge: verifiedShippingCharge,
            shippingMethodId: deliveryPreflight.shippingMethod.id,
            shippingMethodName: deliveryPreflight.shippingMethod.name,
            shippingMethodDescription: deliveryPreflight.shippingMethod.description,
            shippingMethodBaseAmountMinor: deliveryPreflight.shippingMethod.baseAmountMinor,
            shippingFeeWaived: deliveryPreflight.shippingMethod.feeWaived,
            discountAmount: normalizedDiscountAmount,
            currencyCode: taxQuote.currencyCode,
            currencyDecimalPlaces: taxQuote.decimalPlaces,
            subtotalAmountMinor: taxQuote.subtotalMinor,
            shippingAmountMinor: taxQuote.shippingMinor,
            discountAmountMinor: taxQuote.discountMinor,
            taxAmountMinor: taxQuote.taxMinor,
            totalAmountMinor: taxQuote.totalMinor,
            taxLabel: taxQuote.displayLabel,
            pricesIncludeTax: taxQuote.pricesIncludeTax,
            status: data.paymentMethod === PaymentMethod.COD ? OrderStatus.PENDING : OrderStatus.INCOMPLETE,
            paymentMethod: data.paymentMethod,
            paymentStatus: PaymentStatus.UNPAID,
            paidAmount: 0,
            balanceDue: totalAmount,
            fulfillmentStatus: FulfillmentStatus.PENDING,
            inventoryPool: data.inventoryPool,
            inventoryAction: cartValidation.items.some(item => item.inventoryTracked) ? "reserved" : "none",
        },
        items: preparedItems.map((item) => {
            const lineTax = taxQuote.lines.find(
                (line) => line.lineId === item.taxAllocationLineId,
            );
            if (!lineTax) {
                throw new ValidationError("Authoritative tax quote is missing a checkout line. Please retry checkout.");
            }
            return {
                id: item.id,
                taxAllocationLineId: item.taxAllocationLineId,
                cartKey: item.cartKey,
                productId: item.productId,
                variantId: item.variantId,
                quantity: item.quantity,
                price: item.price,
                productName: item.productName,
                variantLabel: item.variantLabel,
                inventoryTracked: item.inventoryTracked,
                productImageMediaId: item.productImageMediaId,
                unitPriceMinor: lineTax.unitPriceMinor,
                lineSubtotalMinor: lineTax.grossAmountMinor,
                discountAmountMinor: lineTax.discountMinor,
                taxableAmountMinor: lineTax.taxableAmountMinor,
                taxAmountMinor: lineTax.taxMinor,
            };
        }),
        discountUsage: appliedDiscountId && normalizedDiscountAmount > 0 ? {
            discountId: appliedDiscountId,
            amountDiscounted: normalizedDiscountAmount,
        } : null,
        promotion: promotionSnapshot,
        requestUrl,
        taxQuote,
    };

    return {
        checkoutToken,
        orderId,
        paymentMethod: data.paymentMethod,
        totalAmount,
        taxQuote,
        commitPayload,
    };
}
