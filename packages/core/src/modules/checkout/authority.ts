import type { Database } from "@scalius/database/client";
import { checkoutAuthority } from "@scalius/database/schema";
import { inArray, sql } from "drizzle-orm";
import { ValidationError } from "@scalius/core/errors";
import {
    resolveActivePaymentMethodsFromRows,
    type GatewaySettingsStoredRow,
    type PaymentMethodsConfig,
} from "../payments/gateway-settings";
import {
    checkoutDocument,
    currencyDocument,
    customerCountriesDocument,
    metaConversionsDocument,
    notificationsDocument,
    paymentMethodsDocument,
    sslcommerzDocument,
    stripeDocument,
    type CurrencySettings,
    type CustomerCountries,
} from "../settings/documents";
import { selectSettingsDocuments } from "../settings/settings-store";
import {
    resolveProductMediaProjectionRows,
    selectCheckoutProductMediaProjectionRows,
    type ProductMediaProjectionRow,
} from "../products/products.media";
import {
    resolveStorefrontCartValidationFromRows,
    selectStorefrontCartProductRows,
    selectStorefrontCartVariantRows,
    type StorefrontCartProductRow,
    type StorefrontCartValidationItem,
    type StorefrontCartValidationResult,
    type StorefrontCartVariantRow,
} from "./cart-validation";
import {
    resolveStorefrontDeliveryPreflightFromRows,
    type StorefrontDeliveryPreflightResult,
} from "./prepare";
import { selectDeliveryRateRowsByIds, type DeliveryRateRow } from "../delivery/zones";
import {
    selectActiveDeliveryLocationRowsByIds,
    type ActiveDeliveryLocationRow,
} from "../delivery/location-validation";
import {
    createStorefrontTaxAuthorityReadPlan,
    type StorefrontTaxAuthoritySnapshot,
} from "../tax/tax.service";

/** Settings documents every checkout snapshot reads in its first statement. */
const CHECKOUT_SETTINGS_DOCUMENTS = [
    currencyDocument,
    customerCountriesDocument,
    notificationsDocument,
    metaConversionsDocument,
    paymentMethodsDocument,
    stripeDocument,
    sslcommerzDocument,
];

export interface StorefrontCheckoutAuthorityInput {
    items: StorefrontCartValidationItem[];
    inventoryPool?: string | null;
    city: string;
    zone: string;
    area?: string | null;
    shippingMethodId?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
}

export interface StorefrontCheckoutSettingsAuthority {
    guestCheckoutEnabled: boolean;
    checkoutMode: "guest_cod_only" | "gateways_only" | "all";
    partialPaymentEnabled: boolean;
    partialPaymentAmount: number;
}

export interface StorefrontCheckoutAuthoritySnapshot {
    authorityRevision: number;
    currency: CurrencySettings;
    cartValidation: StorefrontCartValidationResult;
    deliveryPreflight: StorefrontDeliveryPreflightResult;
    checkoutSettings: StorefrontCheckoutSettingsAuthority;
    allowedCountries: CustomerCountries;
    activePaymentMethods: PaymentMethodsConfig;
    taxAuthority: StorefrontTaxAuthoritySnapshot;
    sideEffects: {
        orderCreatedNotification: boolean;
        metaPurchase: boolean;
    };
}

interface CheckoutSideEffectSettingsRow {
    revision: number;
    hasActiveAdminPushTarget: number;
}

export interface StorefrontCheckoutAuthorityReadPlan {
    statements: unknown[];
    resolve(
        results: readonly unknown[],
        credentialEncryptionKey?: string,
    ): Promise<StorefrontCheckoutAuthoritySnapshot>;
}

export interface StorefrontCheckoutAuthorityBatchReadPlan {
    statements: unknown[];
    resolveSettled(
        results: readonly unknown[],
        credentialEncryptionKey?: string,
    ): Promise<StorefrontCheckoutAuthorityResolution[]>;
    resolve(
        results: readonly unknown[],
        credentialEncryptionKey?: string,
    ): Promise<StorefrontCheckoutAuthoritySnapshot[]>;
}

export type StorefrontCheckoutAuthorityResolution =
    | { ok: true; snapshot: StorefrontCheckoutAuthoritySnapshot }
    | { ok: false; error: unknown };

export const STOREFRONT_CHECKOUT_AUTHORITY_MAX_BATCH = 280;
export const STOREFRONT_CHECKOUT_AUTHORITY_HARD_MAX_BATCH = 2_000;

function uniqueNonEmpty(values: readonly (string | null | undefined)[]): string[] {
    return [...new Set(values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean))];
}

function resolveCheckoutAuthorityStage<T>(code: string, resolve: () => T): T {
    try {
        return resolve();
    } catch (error) {
        if (error instanceof Error && !("code" in error)) {
            Object.defineProperty(error, "code", {
                configurable: true,
                enumerable: false,
                value: code,
            });
        }
        throw error;
    }
}

/**
 * Builds one shared authority read for a coordinator microbatch. Store-wide
 * settings and tax policy are read once, while catalog, media, delivery, and
 * shipping rows are selected from the union of all requested identities. Each
 * checkout is then resolved independently from the same consistent snapshot.
 */
export function createStorefrontCheckoutAuthorityBatchReadPlan(
    db: Database,
    inputs: readonly StorefrontCheckoutAuthorityInput[],
    maxBatch = STOREFRONT_CHECKOUT_AUTHORITY_MAX_BATCH,
): StorefrontCheckoutAuthorityBatchReadPlan {
    if (
        !Number.isSafeInteger(maxBatch)
        || maxBatch < 1
        || maxBatch > STOREFRONT_CHECKOUT_AUTHORITY_HARD_MAX_BATCH
        || inputs.length < 1
        || inputs.length > maxBatch
    ) {
        throw new Error(
            `Checkout authority batch must contain between 1 and ${maxBatch} inputs.`,
        );
    }

    const allItems = inputs.flatMap((input) => input.items);
    const productIds = uniqueNonEmpty(allItems.map((item) => item.productId));
    const variantIds = uniqueNonEmpty(allItems.map((item) => item.variantId));
    const locationIds = uniqueNonEmpty(inputs.flatMap((input) => [
        input.city,
        input.zone,
        input.area,
    ]));
    const shippingMethodIds = uniqueNonEmpty(
        inputs.map((input) => input.shippingMethodId),
    );
    const taxPlan = createStorefrontTaxAuthorityReadPlan(db);
    const statements = [
        selectSettingsDocuments(db, CHECKOUT_SETTINGS_DOCUMENTS),
        selectSettingsDocuments(db, [checkoutDocument]),
        selectStorefrontCartProductRows(db, productIds),
        selectStorefrontCartVariantRows(db, productIds, variantIds),
        selectCheckoutProductMediaProjectionRows(db, productIds, variantIds),
        selectActiveDeliveryLocationRowsByIds(db, locationIds),
        selectDeliveryRateRowsByIds(db, shippingMethodIds),
        db.select({
            revision: checkoutAuthority.revision,
            hasActiveAdminPushTarget: sql<number>`EXISTS(
                SELECT 1 FROM admin_fcm_tokens WHERE is_active = 1
            )`,
        })
            .from(checkoutAuthority)
            .where(inArray(checkoutAuthority.id, ["default"]))
            .limit(1),
        ...taxPlan.statements,
    ];

    return {
        statements,
        async resolveSettled(results, credentialEncryptionKey) {
            if (results.length !== statements.length) {
                throw new Error("Checkout authority read returned an unexpected result count.");
            }
            const genericRows = Array.isArray(results[0])
                ? results[0] as GatewaySettingsStoredRow[]
                : [];
            const documentContext = { encryptionKey: credentialEncryptionKey };
            const [currencyDocumentRead, countriesRead, notificationsRead, metaRead, checkoutRead] = await Promise.all([
                currencyDocument.fromRows(genericRows, documentContext),
                customerCountriesDocument.fromRows(genericRows, documentContext),
                notificationsDocument.fromRows(genericRows, documentContext),
                metaConversionsDocument.fromRows(genericRows, documentContext),
                checkoutDocument.fromRows(
                    Array.isArray(results[1]) ? results[1] as GatewaySettingsStoredRow[] : [],
                    documentContext,
                ),
            ]);
            const currency = currencyDocumentRead.value;
            const site = checkoutRead.value;
            const meta = metaRead.value;
            // A stored token counts even when this isolate cannot decrypt it;
            // the Meta send path performs the strict credential read.
            const metaPurchaseEnabled = meta.isEnabled
                && meta.pixelId.trim().length > 0
                && (meta.accessToken.trim().length > 0 || Boolean(metaRead.secretErrors.accessToken));
            const productRows = Array.isArray(results[2])
                ? results[2] as StorefrontCartProductRow[]
                : [];
            const variantRows = Array.isArray(results[3])
                ? results[3] as StorefrontCartVariantRow[]
                : [];
            const mediaByProduct = resolveCheckoutAuthorityStage(
                "CHECKOUT_MEDIA_PROJECTION",
                () => resolveProductMediaProjectionRows(
                    Array.isArray(results[4]) ? results[4] as ProductMediaProjectionRow[] : [],
                ),
            );
            const locationRows = Array.isArray(results[5])
                ? results[5] as ActiveDeliveryLocationRow[]
                : [];
            const shippingRows = Array.isArray(results[6])
                ? results[6] as DeliveryRateRow[]
                : [];
            const sideEffectRows = Array.isArray(results[7])
                ? results[7] as CheckoutSideEffectSettingsRow[]
                : [];
            const sideEffectSettings = sideEffectRows[0];
            const orderCreatedChannels = notificationsRead.value.orderChannels.order_created ?? [];
            const adminOrderCreatedChannels = notificationsRead.value.adminChannels.order_created ?? [];
            // Staff order emails go to the notification settings' recipient list.
            const staffEmailRecipients = (notificationsRead.value as { staffEmailRecipients?: unknown[] })
                .staffEmailRecipients ?? [];
            const allowedCountries = countriesRead.value;
            let activePaymentMethods: PaymentMethodsConfig;
            try {
                activePaymentMethods = await resolveActivePaymentMethodsFromRows(
                    genericRows,
                    credentialEncryptionKey,
                );
            } catch (error) {
                if (error instanceof Error && !("code" in error)) {
                    Object.defineProperty(error, "code", {
                        configurable: true,
                        enumerable: false,
                        value: "CHECKOUT_PAYMENT_SETTINGS",
                    });
                }
                throw error;
            }
            let taxAuthority: StorefrontTaxAuthoritySnapshot;
            try {
                taxAuthority = taxPlan.resolve(results.slice(8, 11));
            } catch (error) {
                if (error instanceof Error && !("code" in error)) {
                    Object.defineProperty(error, "code", {
                        configurable: true,
                        enumerable: false,
                        value: "CHECKOUT_TAX_AUTHORITY",
                    });
                }
                throw error;
            }
            const authorityRevision = Number(sideEffectSettings?.revision);
            if (!Number.isSafeInteger(authorityRevision) || authorityRevision < 1) {
                throw new Error("Checkout authority revision is unavailable.");
            }

            return inputs.map((input): StorefrontCheckoutAuthorityResolution => {
                try {
                    const cartValidation = resolveStorefrontCartValidationFromRows(
                        input.items,
                        {
                            inventoryPool: input.inventoryPool,
                            currencyCode: currency.currencyCode,
                        },
                        productRows,
                        variantRows,
                        mediaByProduct,
                    );
                    if (!cartValidation.valid) {
                        throw new ValidationError("Some items in your cart need attention.", {
                            itemIssues: cartValidation.issues,
                        });
                    }
                    const deliveryPreflight = resolveStorefrontDeliveryPreflightFromRows(
                        {
                            city: input.city,
                            zone: input.zone,
                            area: input.area,
                            shippingMethodId: input.shippingMethodId,
                        },
                        cartValidation,
                        locationRows,
                        shippingRows.filter((row) => row.id === input.shippingMethodId),
                    );

                    return {
                        ok: true,
                        snapshot: {
                            authorityRevision,
                            currency,
                            cartValidation,
                            deliveryPreflight,
                            checkoutSettings: {
                                guestCheckoutEnabled: site.guestCheckoutEnabled,
                                checkoutMode: site.checkoutMode,
                                partialPaymentEnabled: site.partialPaymentEnabled,
                                partialPaymentAmount: site.partialPaymentAmount,
                            },
                            allowedCountries,
                            activePaymentMethods,
                            taxAuthority,
                            sideEffects: {
                                orderCreatedNotification: Boolean(
                                    (input.customerEmail?.trim()
                                        && orderCreatedChannels.includes("email"))
                                    || (input.customerPhone?.trim()
                                        && orderCreatedChannels.some((channel) =>
                                            channel === "sms" || channel === "whatsapp"
                                        ))
                                    || (Number(sideEffectSettings?.hasActiveAdminPushTarget) === 1
                                        && adminOrderCreatedChannels.includes("push"))
                                    || staffEmailRecipients.length > 0,
                                ),
                                metaPurchase: metaPurchaseEnabled,
                            },
                        },
                    };
                } catch (error) {
                    if (error instanceof Error && !("code" in error)) {
                        Object.defineProperty(error, "code", {
                            configurable: true,
                            enumerable: false,
                            value: "CHECKOUT_INPUT_RESOLVE",
                        });
                    }
                    return { ok: false, error };
                }
            });
        },
        async resolve(results, credentialEncryptionKey) {
            const resolutions = await this.resolveSettled(results, credentialEncryptionKey);
            return resolutions.map((resolution) => {
                if (!resolution.ok) throw resolution.error;
                return resolution.snapshot;
            });
        },
    };
}

/**
 * Builds one bounded, consistent checkout read transaction. The normal order
 * path can therefore do one idempotency lookup, one authority read batch, and
 * one atomic commit instead of serial network round trips for each domain.
 */
export function createStorefrontCheckoutAuthorityReadPlan(
    db: Database,
    input: StorefrontCheckoutAuthorityInput,
): StorefrontCheckoutAuthorityReadPlan {
    const batchPlan = createStorefrontCheckoutAuthorityBatchReadPlan(db, [input]);

    return {
        statements: batchPlan.statements,
        async resolve(results, credentialEncryptionKey) {
            const snapshots = await batchPlan.resolve(results, credentialEncryptionKey);
            return snapshots[0]!;
        },
    };
}

export async function loadStorefrontCheckoutAuthority(
    db: Database,
    input: StorefrontCheckoutAuthorityInput,
    credentialEncryptionKey?: string,
): Promise<StorefrontCheckoutAuthoritySnapshot> {
    const plan = createStorefrontCheckoutAuthorityReadPlan(db, input);
    let results: unknown[];
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch tuple limitation.
        results = await db.batch(plan.statements as any) as unknown[];
    } catch (error) {
        if (error instanceof Error && !("code" in error)) {
            Object.defineProperty(error, "code", {
                configurable: true,
                enumerable: false,
                value: "CHECKOUT_AUTHORITY_BATCH",
            });
        }
        throw error;
    }
    try {
        return await plan.resolve(results, credentialEncryptionKey);
    } catch (error) {
        if (error instanceof Error && !("code" in error)) {
            Object.defineProperty(error, "code", {
                configurable: true,
                enumerable: false,
                value: "CHECKOUT_AUTHORITY_RESOLVE",
            });
        }
        throw error;
    }
}
