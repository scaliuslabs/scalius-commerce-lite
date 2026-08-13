import type { Database } from "@scalius/database/client";
import { checkoutAuthority, settings, siteSettings } from "@scalius/database/schema";
import { inArray, sql } from "drizzle-orm";
import { ValidationError } from "@scalius/core/errors";
import {
    resolveActivePaymentMethodsFromRows,
    STOREFRONT_GATEWAY_SETTING_CATEGORIES,
    type GatewaySettingsStoredRow,
    type PaymentMethodsConfig,
} from "../payments/gateway-settings";
import {
    resolveAllowedCountriesFromRows,
    resolveCurrencySettingsFromRows,
    type CurrencySettings,
} from "../settings/site-settings.service";
import {
    resolveAdminNotificationChannelsFromStoredValue,
    resolveNotificationChannelsFromStoredValue,
} from "../settings/settings.service";
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
    selectActiveStorefrontShippingMethodRowsByIds,
    type StorefrontDeliveryPreflightResult,
    type StorefrontShippingMethodRow,
} from "./orders.storefront";
import {
    selectActiveDeliveryLocationRowsByIds,
    type ActiveDeliveryLocationRow,
} from "./delivery-location-validation";
import {
    createStorefrontTaxAuthorityReadPlan,
    type StorefrontTaxAuthoritySnapshot,
} from "../tax/tax.service";

const CHECKOUT_GENERIC_SETTING_CATEGORIES = [
    "currency",
    "phone",
    ...STOREFRONT_GATEWAY_SETTING_CATEGORIES,
] as const;

export interface StorefrontCheckoutAuthorityInput {
    items: StorefrontCartValidationItem[];
    inventoryPool?: string | null;
    inventoryAuthority?: "snapshot" | "coordinator";
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
    allowedCountries: ReturnType<typeof resolveAllowedCountriesFromRows>;
    activePaymentMethods: PaymentMethodsConfig;
    taxAuthority: StorefrontTaxAuthoritySnapshot;
    sideEffects: {
        orderCreatedNotification: boolean;
        metaPurchase: boolean;
    };
}

interface CheckoutSiteSettingsRow {
    guestCheckoutEnabled: boolean;
    checkoutMode: "guest_cod_only" | "gateways_only" | "all";
    partialPaymentEnabled: boolean;
    partialPaymentAmount: number;
}

interface CheckoutSideEffectSettingsRow {
    revision: number;
    orderChannels: string | null;
    adminChannels: string | null;
    hasActiveAdminPushTarget: number;
    metaPurchaseEnabled: number;
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
        db
            .select({
                category: settings.category,
                key: settings.key,
                value: settings.value,
            })
            .from(settings)
            .where(inArray(settings.category, [...CHECKOUT_GENERIC_SETTING_CATEGORIES])),
        db
            .select({
                guestCheckoutEnabled: siteSettings.guestCheckoutEnabled,
                checkoutMode: siteSettings.checkoutMode,
                partialPaymentEnabled: siteSettings.partialPaymentEnabled,
                partialPaymentAmount: siteSettings.partialPaymentAmount,
            })
            .from(siteSettings)
            .limit(1),
        selectStorefrontCartProductRows(db, productIds),
        selectStorefrontCartVariantRows(db, productIds, variantIds),
        selectCheckoutProductMediaProjectionRows(db, productIds, variantIds),
        selectActiveDeliveryLocationRowsByIds(db, locationIds),
        selectActiveStorefrontShippingMethodRowsByIds(db, shippingMethodIds),
        db.select({
            revision: checkoutAuthority.revision,
            orderChannels: sql<string | null>`(
                SELECT value FROM settings
                WHERE category = 'notifications' AND key = 'order_channels'
                LIMIT 1
            )`,
            adminChannels: sql<string | null>`(
                SELECT value FROM settings
                WHERE category = 'notifications' AND key = 'admin_channels'
                LIMIT 1
            )`,
            hasActiveAdminPushTarget: sql<number>`EXISTS(
                SELECT 1 FROM admin_fcm_tokens WHERE is_active = 1
            )`,
            metaPurchaseEnabled: sql<number>`EXISTS(
                SELECT 1 FROM meta_conversions_settings
                WHERE singleton_key = 'default'
                  AND is_enabled = 1
                  AND length(trim(COALESCE(pixel_id, ''))) > 0
                  AND length(trim(COALESCE(access_token, ''))) > 0
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
            const categoryRows = (category: string) => genericRows.filter(
                (row) => row.category === category,
            );
            const currency = resolveCheckoutAuthorityStage(
                "CHECKOUT_CURRENCY_SETTINGS",
                () => resolveCurrencySettingsFromRows(categoryRows("currency")),
            );
            const siteRows = Array.isArray(results[1])
                ? results[1] as CheckoutSiteSettingsRow[]
                : [];
            const site = siteRows[0];
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
                ? results[6] as StorefrontShippingMethodRow[]
                : [];
            const sideEffectRows = Array.isArray(results[7])
                ? results[7] as CheckoutSideEffectSettingsRow[]
                : [];
            const sideEffectSettings = sideEffectRows[0];
            const orderCreatedChannels = resolveCheckoutAuthorityStage(
                "CHECKOUT_NOTIFICATION_SETTINGS",
                () => resolveNotificationChannelsFromStoredValue(
                    sideEffectSettings?.orderChannels,
                ).order_created ?? [],
            );
            const adminOrderCreatedChannels = resolveCheckoutAuthorityStage(
                "CHECKOUT_ADMIN_NOTIFICATION_SETTINGS",
                () => resolveAdminNotificationChannelsFromStoredValue(
                    sideEffectSettings?.adminChannels,
                ).order_created ?? [],
            );
            const allowedCountries = resolveCheckoutAuthorityStage(
                "CHECKOUT_PHONE_SETTINGS",
                () => resolveAllowedCountriesFromRows(categoryRows("phone")),
            );
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
                            deferRegularInventoryAuthority:
                                input.inventoryAuthority === "coordinator",
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
                            currencyCode: currency.currencyCode,
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
                                guestCheckoutEnabled: site?.guestCheckoutEnabled ?? true,
                                checkoutMode: site?.checkoutMode ?? "all",
                                partialPaymentEnabled: site?.partialPaymentEnabled ?? false,
                                partialPaymentAmount: site?.partialPaymentAmount ?? 0,
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
                                        && adminOrderCreatedChannels.includes("push")),
                                ),
                                metaPurchase:
                                    Number(sideEffectSettings?.metaPurchaseEnabled) === 1,
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
