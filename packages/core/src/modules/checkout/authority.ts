import type { Database } from "@scalius/database/client";
import { checkoutAuthority } from "@scalius/database/schema";
import { inArray, sql } from "drizzle-orm";
import { ValidationError } from "@scalius/core/errors";
import {
  type AppPaymentUsability,
  type GatewaySettingsStoredRow,
  type PaymentMethodsConfig,
  resolveActivePaymentMethodsFromRows,
} from "../payments";
import {
  acceptedCustomerCountries,
  checkoutDocument,
  currencyDocument,
  type CurrencySettings,
  customerAuthDocument,
  type CustomerCountries,
  customerCountriesDocument,
  metaConversionsDocument,
  paymentMethodsDocument,
  sslcommerzDocument,
  stripeDocument,
} from "../settings";
import type { CheckoutContactFieldSettings } from "./contact-fields";
import { selectSettingsDocuments } from "../../settings-store";
import { notificationsDocument } from "../notifications";
import {
  type ProductBundleRow,
  type ProductMediaProjectionRow,
  resolveProductMediaProjectionRows,
  selectActiveProductBundleRows,
  selectCheckoutProductMediaProjectionRows,
} from "../products";
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
import {
  type ActiveDeliveryLocationRow,
  type DeliveryRateRow,
  normalizeDeliveryDestination,
  selectActiveDeliveryLocationRowsByIds,
  selectDeliveryRateRowsByIds,
} from "../delivery";
import { createStorefrontTaxAuthorityReadPlan, type StorefrontTaxAuthoritySnapshot } from "../tax";
import { resolveCheckoutPriceScope } from "../price-lists";
import { backupPriceIncrementSql, sellingCountriesFromSql, sellingCountriesSql, storeCurrencyOf } from "../markets";

/** Settings documents every checkout snapshot reads in its first statement. */
const CHECKOUT_SETTINGS_DOCUMENTS = [
    currencyDocument,
    customerAuthDocument,
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
    /** The shipping country (absent: Bangladesh). A `delivery` rate must be one of its zone's. */
    shippingCountryCode?: string | null;
    /** Needed only for a `delivery` rate in Bangladesh (its City/Thana/Area). */
    city?: string | null;
    zone?: string | null;
    area?: string | null;
    /** Another country's admin area and postal code: shipping zones match on them. */
    shippingAdminArea?: string | null;
    shippingPostalCode?: string | null;
    shippingMethodId?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    /** The billed country: the order's market when nothing physical ships (MARKETS-DESIGN D5). */
    billingCountryCode?: string | null;
    /** The signed-in buyer: segment price lists price their members (awaited only when one applies). */
    customerId?: string | null | PromiseLike<string | null>;
}

export interface StorefrontCheckoutSettingsAuthority {
    guestCheckoutEnabled: boolean;
    checkoutMode: "guest_cod_only" | "gateways_only" | "all";
    partialPaymentEnabled: boolean;
    partialPaymentAmount: number;
    /** Settings → Checkout: every order asks for a full billing address. */
    requireFullBillingAddress: boolean;
}

/** The shop currency document and the backup market's price increment every checkout prices at. */
export type CheckoutCurrency = CurrencySettings & { priceIncrementMinor: number };

export interface StorefrontCheckoutAuthoritySnapshot {
    authorityRevision: number;
    currency: CheckoutCurrency;
    cartValidation: StorefrontCartValidationResult;
    deliveryPreflight: StorefrontDeliveryPreflightResult;
    checkoutSettings: StorefrontCheckoutSettingsAuthority;
    /** The phone countries checkout accepts: the merchant's policy united with `shippingCountries`. */
    allowedCountries: CustomerCountries;
    /** The countries the active markets sell to, sorted: checkout ships only there. */
    shippingCountries: string[];
    /** Settings → Customer accounts: which contact fields checkout collects. */
    contactFields: CheckoutContactFieldSettings;
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
    /** The backup market's stored price increment (MARKETS-DESIGN D1), read in this row. */
    backupPriceIncrementMinor: number | null;
    /** The countries the active markets sell to (comma-separated), read in this row. */
    sellingCountries: string | null;
}

/**
 * `appPayments`: which app payment providers can take a payment now
 * (`resolveAppPaymentUsability`); app methods missing from it are not offered.
 */
export interface StorefrontCheckoutAuthorityReadPlan {
    statements: unknown[];
    resolve(
        results: readonly unknown[],
        credentialEncryptionKey?: string,
        appPayments?: AppPaymentUsability,
    ): Promise<StorefrontCheckoutAuthoritySnapshot>;
}

export interface StorefrontCheckoutAuthorityBatchReadPlan {
    statements: unknown[];
    resolveSettled(
        results: readonly unknown[],
        credentialEncryptionKey?: string,
        appPayments?: AppPaymentUsability,
    ): Promise<StorefrontCheckoutAuthorityResolution[]>;
    resolve(
        results: readonly unknown[],
        credentialEncryptionKey?: string,
        appPayments?: AppPaymentUsability,
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
    const destinations = inputs.map((input) => normalizeDeliveryDestination({
        countryCode: input.shippingCountryCode,
        city: input.city,
        zone: input.zone,
        area: input.area,
    }));
    const locationIds = uniqueNonEmpty(destinations.flatMap((destination) => [
        destination.city,
        destination.zone,
        destination.area,
    ]));
    // The zone regions of every destination country ride on the rate rows.
    const destinationCountries = [...new Set(destinations.map((destination) => destination.countryCode))];
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
        selectDeliveryRateRowsByIds(db, shippingMethodIds, destinationCountries),
        // Quantity bundle tiers price the cart; any change bumps the revision below.
        selectActiveProductBundleRows(db, productIds),
        db.select({
            revision: checkoutAuthority.revision,
            hasActiveAdminPushTarget: sql<number>`EXISTS(
                SELECT 1 FROM admin_fcm_tokens WHERE is_active = 1
            )`,
            // The price increment every checkout prices at, in a row this read already runs.
            backupPriceIncrementMinor: backupPriceIncrementSql(),
            // The countries checkout ships to, in the same row.
            sellingCountries: sellingCountriesSql(),
        })
            .from(checkoutAuthority)
            .where(inArray(checkoutAuthority.id, ["default"]))
            .limit(1),
        ...taxPlan.statements,
    ];

    return {
        statements,
        async resolveSettled(results, credentialEncryptionKey, appPayments) {
            if (results.length !== statements.length) {
                throw new Error("Checkout authority read returned an unexpected result count.");
            }
            const genericRows = Array.isArray(results[0])
                ? results[0] as GatewaySettingsStoredRow[]
                : [];
            const documentContext = { encryptionKey: credentialEncryptionKey };
            const [currencyDocumentRead, countriesRead, notificationsRead, metaRead, checkoutRead, identityRead] = await Promise.all([
                currencyDocument.fromRows(genericRows, documentContext),
                customerCountriesDocument.fromRows(genericRows, documentContext),
                notificationsDocument.fromRows(genericRows, documentContext),
                metaConversionsDocument.fromRows(genericRows, documentContext),
                checkoutDocument.fromRows(
                    Array.isArray(results[1]) ? results[1] as GatewaySettingsStoredRow[] : [],
                    documentContext,
                ),
                customerAuthDocument.fromRows(genericRows, documentContext),
            ]);
            const sideEffectRows = Array.isArray(results[8])
                ? results[8] as CheckoutSideEffectSettingsRow[]
                : [];
            const sideEffectSettings = sideEffectRows[0];
            const currency: CheckoutCurrency = {
                ...currencyDocumentRead.value,
                priceIncrementMinor: storeCurrencyOf(currencyDocumentRead.value, sideEffectSettings?.backupPriceIncrementMinor).priceIncrementMinor,
            };
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
            const bundleRows = Array.isArray(results[7])
                ? results[7] as ProductBundleRow[]
                : [];
            const orderCreatedChannels = notificationsRead.value.orderChannels.order_created ?? [];
            const adminOrderCreatedChannels = notificationsRead.value.adminChannels.order_created ?? [];
            // Staff order emails go to the notification settings' recipient list.
            const staffEmailRecipients = (notificationsRead.value as { staffEmailRecipients?: unknown[] })
                .staffEmailRecipients ?? [];
            const shippingCountries = sellingCountriesFromSql(sideEffectSettings?.sellingCountries);
            // The phone countries checkout accepts: the merchant's list united
            // with the countries the markets sell to (one rule, in settings).
            const allowedCountries = acceptedCustomerCountries(countriesRead.value, shippingCountries);
            let activePaymentMethods: PaymentMethodsConfig;
            try {
                activePaymentMethods = await resolveActivePaymentMethodsFromRows(
                    genericRows,
                    credentialEncryptionKey,
                    appPayments,
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
                taxAuthority = taxPlan.resolve(results.slice(9, 9 + taxPlan.statements.length));
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

            // Each checkout's market prices its lines (the order's market rule);
            // segment membership is read only when a segment list applies.
            const priceScopes = await Promise.all(inputs.map((input) => resolveCheckoutPriceScope(db, {
                items: input.items,
                productRows,
                variantRows,
                currency: { code: currency.currencyCode, incrementMinor: currency.priceIncrementMinor },
                signals: {
                    placing: true,
                    shippingCountryCode: input.shippingCountryCode,
                    billingCountryCode: input.billingCountryCode,
                    customerId: input.customerId,
                },
            }).catch((error: unknown) => ({ error }))));

            return inputs.map((input, inputIndex): StorefrontCheckoutAuthorityResolution => {
                try {
                    const priceScope = priceScopes[inputIndex];
                    if (priceScope && "error" in priceScope) throw priceScope.error;
                    const cartValidation = resolveStorefrontCartValidationFromRows(
                        input.items,
                        {
                            inventoryPool: input.inventoryPool,
                            currencyCode: currency.currencyCode,
                            priceIncrementMinor: currency.priceIncrementMinor,
                            priceScope,
                        },
                        productRows,
                        variantRows,
                        mediaByProduct,
                        bundleRows,
                    );
                    if (!cartValidation.valid) {
                        throw new ValidationError("Some items in your cart need attention.", {
                            itemIssues: cartValidation.issues,
                        });
                    }
                    const deliveryPreflight = resolveStorefrontDeliveryPreflightFromRows(
                        {
                            shippingCountryCode: input.shippingCountryCode,
                            city: input.city,
                            zone: input.zone,
                            area: input.area,
                            shippingAdminArea: input.shippingAdminArea,
                            shippingPostalCode: input.shippingPostalCode,
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
                                requireFullBillingAddress: site.requireFullBillingAddress,
                            },
                            allowedCountries,
                            shippingCountries,
                            contactFields: {
                                email: identityRead.value.email,
                                whatsapp: identityRead.value.whatsapp,
                                phoneOptionalForDigital: identityRead.value.phoneOptionalForDigital,
                            },
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
        async resolve(results, credentialEncryptionKey, appPayments) {
            const resolutions = await this.resolveSettled(results, credentialEncryptionKey, appPayments);
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
        async resolve(results, credentialEncryptionKey, appPayments) {
            const snapshots = await batchPlan.resolve(results, credentialEncryptionKey, appPayments);
            return snapshots[0]!;
        },
    };
}

export async function loadStorefrontCheckoutAuthority(
    db: Database,
    input: StorefrontCheckoutAuthorityInput,
    credentialEncryptionKey?: string,
    appPayments?: AppPaymentUsability,
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
        return await plan.resolve(results, credentialEncryptionKey, appPayments);
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
