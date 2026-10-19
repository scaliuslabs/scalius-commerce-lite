// src/modules/orders/types.ts
// Shared TypeScript interfaces for the orders module.

import type { OrderNotificationType } from "../notifications/browser";
import type { ActiveRefundOperationView, OrderRefundAttemptView } from "../payments/browser";
import type { TaxQuote } from "../tax/browser";
import type { PromotionCheckoutSnapshot } from "../promotions/browser";
import type { AppliedAppDiscount, AppObjectCommit, CheckoutRateOption } from "@scalius/shared/checkout-app-facts";
import type { FunctionCart } from "@scalius/shared/plugins";
import type { CustomerRequestType } from "../settings/browser";
import type { DeliveryMethodKind, FulfillmentType } from "@scalius/shared/fulfilment";
import type { OrderChannel } from "@scalius/shared/order-channel";
import type {
    AdminOrderFulfilmentView,
    OrderLineFulfilmentFacts,
    OrderPickupView,
} from "./line-presentation";

export interface OrderSupportRequestView {
    id: string;
    orderId: string;
    customerId: string | null;
    type: CustomerRequestType;
    status: string;
    active: boolean;
    severity: "info" | "success" | "warning" | "danger";
    label: string;
    actionLabel: string;
    reason: string;
    returnId: string | null;
    submittedAt: string | null;
    resolvedAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

// ─────────────────────────────────────────
// Admin types
// ─────────────────────────────────────────

export interface OrderShipmentSummary {
    id: string;
    providerId: string | null;
    providerType: string | null;
    providerName: string | null;
    status: string;
    rawStatus: string | null;
    externalId: string | null;
    trackingId: string | null;
    lastChecked: Date | null;
    updatedAt: Date;
    createdAt: Date;
}

export type OrderShipmentRecoveryState =
    | "none"
    | "creating"
    | "needs_attention"
    | "failed";

/** Why a shipment needs attention, as a stable code the dashboard words in its own language. */
export const ORDER_SHIPMENT_RECOVERY_REASONS = [
    "none",
    "courier_unconfirmed",
    "reconcile_required",
    "creating",
    "claim_expired",
    "failed",
] as const;
export type OrderShipmentRecoveryReason = (typeof ORDER_SHIPMENT_RECOVERY_REASONS)[number];

export interface OrderShipmentRecoverySummary {
    state: OrderShipmentRecoveryState;
    reason: OrderShipmentRecoveryReason;
    severity: "info" | "warning" | "danger";
    activeLock: boolean;
    label: string;
    message: string | null;
    shipmentId: string | null;
    status: string | null;
    providerType: string | null;
    canRefresh: boolean;
    canRetryCreate: boolean;
    canRepair: boolean;
    unknownOutcome: boolean;
    updatedAt: Date | null;
}

export type UnknownShipmentResolutionResult =
    | (OrderShipmentReconciliationResult & {
        resolution: "provider_confirmed_existing" | "merchant_confirmed_existing";
    })
    | {
        status: "released";
        resolution: "merchant_confirmed_not_created" | "merchant_confirmed_cancelled";
        orderId: string;
        shipmentId: string;
        claimCleared: true;
        orderVersion: number;
        message: string;
    };

export interface OrderShipmentReconciliationResult {
    status: "repaired";
    orderId: string;
    shipmentId: string;
    orderStatus: string;
    shipmentStatus: string;
    orderStatusChanged: boolean;
    inventoryReconciled: boolean;
    claimCleared: boolean;
    trackingId: string | null;
    message: string;
    /** Internal cache signal; API responses must not expose this field. */
    availabilityTransitionVariantIds: string[];
}

export type OrderPaymentRecoveryState =
    | "none"
    | "awaiting_payment"
    | "processing"
    | "needs_attention";

export type OrderPaymentRecoveryFilter =
    | "recoverable"
    | Exclude<OrderPaymentRecoveryState, "none">;

export interface OrderPaymentRecoverySummary {
    state: OrderPaymentRecoveryState;
    label: string;
    message: string | null;
    gateway: string | null;
    paymentType: string | null;
    status: string | null;
    attempts: number;
    activeProcessing: boolean;
    staleProcessing: boolean;
    updatedAt: Date | null;
}

/** Why part of an order can no longer be edited; the dashboard words each one. */
export type OrderEditLockReason =
    | "shipped"
    | "closed"
    | "paid"
    | "online_payment"
    | "discount"
    | "history"
    | "inventory"
    | "archived"
    | "busy"
    | "unavailable";

export interface OrderEditReadiness {
    /** Products, quantities, discount and delivery charge (quote-backed amendment). */
    items: { allowed: boolean; reason: OrderEditLockReason | null };
    /** Customer name, phone, email and delivery address. */
    details: { allowed: boolean; reason: OrderEditLockReason | null };
}

/**
 * An order's shipping-address snapshot (MARKETS-DESIGN D7, migration 0113) as
 * stored on `orders` and as every order read returns it: the canonical fields
 * beside Bangladesh's City/Thana/Area adapter. `shippingAddress` is the first
 * street line. All null when nothing ships.
 */
export interface OrderShippingAddressFields {
    shippingAddress: string | null;
    shippingAddressLine2: string | null;
    /** ISO 3166-1 alpha-2; it decides the order's market. */
    shippingCountryCode: string | null;
    shippingDependentLocality: string | null;
    shippingLocality: string | null;
    shippingAdminArea: string | null;
    shippingPostalCode: string | null;
    shippingCompany: string | null;
    /** The recipient when not the order contact; null means `customerName`. */
    shippingName: string | null;
    /** The recipient's phone (E.164) when not the contact's; null means `customerPhone`. */
    shippingPhone: string | null;
    shippingValidationSkipped: boolean;
    city: string | null;
    zone: string | null;
    area: string | null;
    cityName: string | null;
    zoneName: string | null;
    areaName: string | null;
}

/**
 * An order's billing-address snapshot (migration 0119): the canonical fields
 * with a `billing` prefix, without Bangladesh's courier adapter.
 * `billingSameAsShipping` true means the shipping address bills (the other
 * fields are then null); false without a country means no billing address.
 */
export interface OrderBillingAddressFields {
    billingSameAsShipping: boolean;
    /** The billing name when not the order contact; null means `customerName`. */
    billingName: string | null;
    billingCompany: string | null;
    /** The first street line; null for a minimal billing address. */
    billingAddress: string | null;
    billingAddressLine2: string | null;
    /** ISO 3166-1 alpha-2; an order that ships nothing is taxed and placed here. */
    billingCountryCode: string | null;
    billingDependentLocality: string | null;
    billingLocality: string | null;
    billingAdminArea: string | null;
    billingPostalCode: string | null;
    /** E.164 when not the contact's. */
    billingPhone: string | null;
    billingValidationSkipped: boolean;
}

export interface OrderListItem {
    id: string;
    /** The order's currency (its market's, MARKETS-DESIGN step 6). */
    currencyCode?: string | null;
    customerName: string;
    customerPhone: string | null;
    customerEmail: string | null;
    customerId: string | null;
    totalAmount: number;
    shippingCharge: number;
    discountAmount: number | null;
    status: string;
    paymentStatus: string;
    paidAmount: number;
    paymentMethod: string;
    fulfillmentStatus: string;
    createdAt: Date;
    updatedAt: Date;
    /** Browser-loaded CAS token for archive/restore and other list mutations. */
    version: number;
    itemCount: number;
    /** The shipping country (null when nothing ships); couriers and fraud checks are offered by it. */
    shippingCountryCode: string | null;
    shippingLocality: string | null;
    city: string | null;
    zone: string | null;
    area: string | null;
    cityName: string | null;
    zoneName: string | null;
    areaName: string | null;
    latestShipment: OrderShipmentSummary | null;
    shipmentRecovery: OrderShipmentRecoverySummary;
    paymentRecovery: OrderPaymentRecoverySummary;
    activeRefundOperation: ActiveRefundOperationView | null;
    /** Sequential store number, shown as "#1001". */
    orderNumber: number | null;
    archivedAt: Date | null;
    /** The surface that created the order (COMMERCE-HOOKS H2); never changes. */
    channel: OrderChannel;
    /** Where it came in within the channel (`facebook`, `walk_in`, …), a lowercase slug. */
    channelSource: string | null;
    /** The sales channel the order sold from (MARKETS-DESIGN D6): its publications and locations. */
    salesChannelId: string;
    /** The open customer request, so it isn't shipped unnoticed. */
    openRequestType: "cancel_pre_shipment" | "return" | "refund" | null;
    /** An app put the order on hold for staff review: nothing ships or moves on until it is released. */
    onHold: boolean;
    cod: { status: string; deliveryAttempts: number } | null;
    /** Value of received returns not yet given back (major units). */
    refundDue: number;
    refundedAmount: number;
    /** Some line ships, so the order has a delivery address. */
    requiresShipping: boolean;
    /** The order's one delivery method; null when nothing physical was bought. */
    shippingMethodKind: DeliveryMethodKind | null;
    /** Staff marked a pickup order ready to collect. */
    pickupReadyAt: Date | null;
}

export interface OrderDetails extends OrderListItem, OrderBillingAddressFields {
    /** Shop-currency amounts of an order paid in a market's own currency (MARKETS-DESIGN D3); null: same-currency. */
    moneyChain?: {
        shopCurrencyCode: string;
        rate: string;
        source: string;
        asOf: string | null;
        lockedUntil: string | null;
        subtotalShopAmount: number;
        shippingShopAmount: number;
        discountShopAmount: number;
        taxShopAmount: number;
        totalShopAmount: number;
    } | null;
    editReadiness: OrderEditReadiness;
    /** The order's own location (null = the store default). */
    fulfillmentLocationId: string | null;
    /**
     * Where the order's stock leaves from: its own location or the default
     * (`explicit` false). Changeable while `editReadiness.details` allows edits.
     */
    fulfillmentLocation: { id: string; name: string; explicit: boolean } | null;
    notes: string | null;
    attributes?: Record<string, string>;
    /** Null when nothing ships (pickup, service-only or digital orders): the first street line. */
    shippingAddress: string | null;
    shippingAddressLine2: string | null;
    shippingDependentLocality: string | null;
    shippingAdminArea: string | null;
    shippingPostalCode: string | null;
    shippingCompany: string | null;
    /** The recipient when not the order contact (null: `customerName`). */
    shippingName: string | null;
    /** The recipient's phone when not the contact's (null: `customerPhone`). */
    shippingPhone: string | null;
    shippingValidationSkipped: boolean;
    customerId: string | null;
    pickup: OrderPickupView | null;
    /** Every fulfilment in the ledger, voided ones included. */
    fulfillments: AdminOrderFulfilmentView[];
    /** The order thread, once the buyer or staff started one. */
    conversation: { id: string; unread: boolean } | null;
    /** The customer record the order is filed under; its title can differ from the order's own name. */
    customerRecord: { id: string; name: string; phone: string | null; kind: "account" | "guest" | "merchant" } | null;
    balanceDue: number | null;
    deletedAt: Date | null;
    currencyCode: string | null;
    currencyDecimalPlaces: number | null;
    subtotalAmountMinor: number | null;
    shippingAmountMinor: number | null;
    shippingMethodId: string | null;
    shippingMethodName: string | null;
    shippingMethodDescription: string | null;
    shippingMethodBaseAmountMinor: number | null;
    shippingFeeWaived: boolean | null;
    discountAmountMinor: number | null;
    taxAmountMinor: number;
    totalAmountMinor: number | null;
    taxLabel: string | null;
    pricesIncludeTax: boolean;
    /** Every discount applied at checkout: one entry per promotion, then one per app discount (major units). */
    discounts: Array<{
        source: "promotion" | "app";
        /** Null for an app's discount. */
        promotionId: string | null;
        /** The app that gave it; null for the store's own discounts. */
        appId: string | null;
        appName: string | null;
        name: string;
        code: string | null;
        method: "automatic" | "code";
        amount: number;
    }>;
    /** Apps' advisory risk checks of the order, newest first; never acted on automatically. */
    appRiskChecks: Array<{
        appId: string;
        appName: string;
        level: "low" | "medium" | "high";
        reasons: string[];
        checkedAt: Date;
    }>;
    /** Apps' holds for staff review (`ctx.orders.hold`), open ones first. */
    holds: Array<{
        id: string;
        appId: string;
        appName: string;
        reason: string;
        placedAt: Date;
        releasedAt: Date | null;
    }>;
    items: (OrderLineFulfilmentFacts & {
        id: string;
        productId: string;
        variantId: string | null;
        quantity: number;
        price: number;
        productName: string | null;
        productImage: string | null;
        variantLabel: string | null;
        /** Stock is tracked for this line (cancel/return restock counts only these). */
        inventoryTracked: boolean;
        unitPriceMinor: number | null;
        lineSubtotalMinor: number | null;
        discountAmountMinor: number | null;
        taxableAmountMinor: number | null;
        taxAmountMinor: number;
    })[];
    refundAttempts: OrderRefundAttemptView[];
    activeRefundOperation: ActiveRefundOperationView | null;
    supportRequests: OrderSupportRequestView[];
}

// ─────────────────────────────────────────
// Storefront types
// ─────────────────────────────────────────

export interface StorefrontOrderItem {
    cartKey?: string | null;
    productId: string;
    variantId: string;
    quantity: number;
    /**
     * The unit price the buyer saw: base plus surcharges. Absent only on a
     * line the platform made (a cart transform's component), whose buyer
     * line was checked instead.
     */
    price?: number;
    productName?: string | null;
    variantLabel?: string | null;
    /** Buyer inputs `[{ key, value }]` (line-item properties). */
    properties?: Array<{ key: string; value: string }>;
}

export interface CreateStorefrontOrderInput {
    checkoutRequestId: string;
    expectedQuoteFingerprint: string;
    customerName: string;
    /**
     * E.164, or null for an order the shared contact rule lets go without a
     * phone (`orderContactNeeds`): only digital or service lines, paid in
     * full online, outside Bangladesh, with the merchant's opt-in.
     */
    customerPhone: string | null;
    customerEmail: string | null;
    /** A separate WhatsApp number, kept only when Customer accounts asks for one. */
    customerWhatsapp?: string | null;
    /**
     * The shipping address, required only when a line ships (a `delivery`
     * rate for physical items): its country (absent: Bangladesh, whose form
     * sends the City/Thana/Area ids instead of a locality), first and second
     * line, and what the country's rules ask for.
     */
    shippingCountryCode?: string | null;
    shippingAddress?: string | null;
    shippingAddressLine2?: string | null;
    shippingDependentLocality?: string | null;
    shippingLocality?: string | null;
    shippingAdminArea?: string | null;
    shippingPostalCode?: string | null;
    city?: string | null;
    zone?: string | null;
    area?: string | null;
    /**
     * The billing address (migration 0119, Shopify's rule). An order that
     * ships uses its shipping address unless `billingSameAsShipping` is false
     * and a billing address is sent. An order that ships nothing needs one:
     * at least its country (absent: the store's only selling country), plus
     * what its rules and the merchant's "Require full billing address" ask.
     */
    billingSameAsShipping?: boolean | null;
    billingCountryCode?: string | null;
    billingName?: string | null;
    billingCompany?: string | null;
    billingAddress?: string | null;
    billingAddressLine2?: string | null;
    billingDependentLocality?: string | null;
    billingLocality?: string | null;
    billingAdminArea?: string | null;
    billingPostalCode?: string | null;
    notes: string | null;
    attributes?: Record<string, string>;
    items: StorefrontOrderItem[];
    /** Discount codes the buyer applied; each must still apply at commit. */
    discountCodes: string[];
    shippingCharge: number;
    shippingMethodId?: string | null;
    paymentMethod: string;
    inventoryPool: string;
    /**
     * Gift-card apply handles (≤ 5), in the order the buyer added them
     * (Wave B §4.3). Absent or empty: no tender, exactly as before.
     */
    giftCards?: Array<{ handle: string }>;
    /** The amount due the buyer reviewed (minor units); required with gift cards. */
    expectedAmountDueMinor?: number;
}

/** One buyer-facing reason a gift card is not (fully) used on an order. */
export interface StorefrontGiftCardIssue {
    /** The handle it is about; null for an order-level issue. */
    handle: string | null;
    code: "GIFT_CARD_UNUSABLE" | "GIFT_CARD_DUPLICATE" | "GIFT_CARD_NOT_NEEDED" | "GIFT_CARD_NOT_ELIGIBLE";
    message: string;
}

/** Gift cards as a tender on one priced order (Wave B §4.3). */
export interface StorefrontGiftCardTenderSummary {
    /** The handles the buyer sent, in order. */
    handles: string[];
    /** What gift cards can never pay: the gift-card lines' totals. */
    giftCardLineTotalMinor: number;
    /** Positive applications, in buyer order: exactly the `redeem` debits the commit writes. */
    applied: Array<{
        giftCardId: string;
        handle: string;
        last4: string;
        appliedMinor: number;
        /** The card's balance before this order (in the order's currency). */
        balanceMinor: number;
        /** A card in another store currency (MARKETS-DESIGN step 6): its currency and what this order debits in it. */
        card?: { currencyCode: string; debitMinor: number };
    }>;
    appliedTotalMinor: number;
    /** `totalMinor − appliedTotalMinor`: what cash on delivery or a gateway collects. */
    amountDueMinor: number;
    /** Handles that no longer name a usable card. */
    unusableHandles: string[];
    issues: StorefrontGiftCardIssue[];
}

export interface CreateStorefrontOrderIdentity {
    orderId: string;
    checkoutToken: string;
}

export interface CreateStorefrontOrderCustomerIdentity {
    customerId: string;
    source: "authenticated";
}

export interface CreateStorefrontOrderResult {
    checkoutToken: string;
    orderId: string;
    paymentMethod: string;
    taxQuote: TaxQuote;
    commitPayload: StorefrontOrderCommitPayload;
    /** Some line ships: the order carries an address. */
    requiresShipping: boolean;
    /** `propertiesHash` per line, in cart order, for the quote fingerprint. */
    linePropertiesHashes: string[];
    /** The gift-card tender; no handles means none (amount due = total). */
    giftCardTender: StorefrontGiftCardTenderSummary;
    /** The chosen delivery rate as reviewed (an app may have renamed or priced it); fingerprinted. */
    shippingMethod: StorefrontOrderShippingMethodSnapshot | null;
    /** App discounts the order carries (after the platform's). */
    appDiscounts: AppliedAppDiscount[];
    /** Delivery options an app changed; null when none did. */
    shippingRates: CheckoutRateOption[] | null;
    /** The cart apps saw; null when no app implements a cart point. */
    appCart: FunctionCart | null;
}

/** Immutable buyer-reviewed delivery method facts captured for a storefront order. */
export interface StorefrontOrderShippingMethodSnapshot {
    id: string;
    name: string;
    description: string | null;
    /** Configured method fee before any product-level delivery waiver. */
    baseAmountMinor: number;
    feeWaived: boolean;
}

/** Prepared, server-authoritative storefront order data committed synchronously by checkout. */
export interface StorefrontOrderCommitPayload {
    checkoutToken: string;
    /** Read-to-commit fence for catalog, delivery, tax, and checkout policy facts. */
    checkoutAuthorityRevision: number | null;
    /** Buyer-independent async work proven deliverable by the checkout authority snapshot. */
    checkoutSideEffects?: {
        orderCreatedNotification: boolean;
        metaPurchase: boolean;
    };
    /** Verified storefront account owner. Guest checkout deliberately keeps this null. */
    existingCustomer: { id: string } | null;
    /**
     * The shipping-address snapshot (all null unless something ships), the
     * billing-address snapshot and the order's other facts.
     */
    orderData: OrderShippingAddressFields & Partial<OrderBillingAddressFields> & {
        id: string;
        customerName: string;
        /** Null without a phone; stored as NO_PHONE (`storedPhone`). */
        customerPhone: string | null;
        customerEmail: string | null;
        customerWhatsapp?: string | null;
        notes: string | null;
        attributes?: string;
        /** Null when nothing physical was bought (no delivery method). */
        shippingMethodId: string | null;
        shippingMethodName: string | null;
        shippingMethodDescription: string | null;
        shippingMethodBaseAmountMinor: number | null;
        shippingFeeWaived: boolean | null;
        requiresShipping?: boolean;
        shippingMethodKind?: DeliveryMethodKind | null;
        pickupAddress?: string | null;
        pickupHours?: string | null;
        currencyCode: string;
        currencyDecimalPlaces: number;
        /**
         * The order's money chain when it is not in the shop currency
         * (MARKETS-DESIGN D3, step 6): the shop currency, the locked rate (shop
         * units per presentment unit), its source, when it was set and until
         * when the order keeps it (epoch seconds). Absent: same-currency.
         */
        fx?: {
            shopCurrency: string;
            fxRate: string;
            fxSource: string;
            fxAsOf: number | null;
            fxLockedUntil: number | null;
        };
        subtotalAmountMinor: number;
        shippingAmountMinor: number;
        discountAmountMinor: number;
        taxAmountMinor: number;
        totalAmountMinor: number;
        taxLabel: string;
        pricesIncludeTax: boolean;
        status: string;
        paymentMethod: string;
        paymentStatus: string;
        paidAmountMinor: number;
        balanceDueMinor: number;
        fulfillmentStatus: string;
        inventoryPool: string;
        inventoryAction: string;
    };
    items: {
        id: string;
        taxAllocationLineId: string;
        cartKey?: string | null;
        productId: string;
        variantId: string;
        quantity: number;
        productName: string | null;
        variantLabel: string | null;
        inventoryTracked?: boolean;
        /** Historical image/poster Media asset selected before the order batch. */
        productImageMediaId: string | null;
        /** How this line reaches the buyer; frozen by the commit. Defaults to `ship`. */
        fulfillmentType?: FulfillmentType;
        /** Serialized `order_items.properties` snapshot, or null without buyer inputs. */
        properties?: string | null;
        propertiesPriceMinor?: number;
        /** Unit price before surcharges. */
        baseUnitPriceMinor?: number;
        unitPriceMinor: number;
        lineSubtotalMinor: number;
        discountAmountMinor: number;
        /**
         * The quantity-bundle saving in `discountAmountMinor`. An order is
         * priced by its promotion or its bundles, never both
         * (checkout/bundle-discounts.ts). Absent means none.
         */
        bundleDiscountMinor?: number;
        taxableAmountMinor: number;
        taxAmountMinor: number;
    }[];
    /** The applied discount (code or automatic); re-verified during the order commit. */
    promotion?: PromotionCheckoutSnapshot | null;
    /**
     * App discounts on top of the platform's (checkout/app-functions.ts),
     * lines by `taxAllocationLineId`. Recorded with the order as immutable
     * `app_discount` facts in the commit batch. Absent means none.
     */
    appDiscounts?: AppliedAppDiscount[];
    /**
     * App snapshot writes (a loyalty balance the discount spends), written in
     * the commit batch at the revision each app saw: a concurrent change
     * fails the whole order. Each belongs to an app with an applied discount.
     */
    appObjectCommits?: AppObjectCommit[];
    /**
     * Gift-card debits (the hold), written in the commit batch after the
     * order; the ledger guards refuse a card that changed since the quote.
     * Absent when no card applies.
     */
    giftCardRedemptions?: Array<{
        giftCardId: string;
        appliedMinor: number;
        /** A card in another store currency: its currency and the debit in it (MARKETS-DESIGN step 6). */
        card?: { currencyCode: string; debitMinor: number };
    }>;
    requestUrl: string;
    taxQuote: TaxQuote;
}

// ─────────────────────────────────────────
// Status update types
// ─────────────────────────────────────────

export interface StatusUpdateResult {
    message: string;
    /** Internal cache signal; API responses must not expose this field. */
    availabilityTransitionVariantIds: string[];
    /** Present when the new status warrants a customer notification. */
    notification?: {
        orderId: string;
        customerEmail?: string;
        customerName: string;
        notificationType: OrderNotificationType;
        trackingId?: string;
        dedupeKey?: string;
        previousStatus?: string;
        newStatus?: string;
        version?: number;
    };
}
