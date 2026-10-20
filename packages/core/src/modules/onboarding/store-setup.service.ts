// Store setup (Shopify's "Tell us about your store"): after the first admin
// exists, one step names the store and picks its country, currency, language,
// time zone and units. It writes, in one batch, the business name and
// country, the backup market (name, handle, its one country, the root
// language and the currency's default price increment), the shop currency and
// the store defaults (docs/STORE-DEFAULTS.md).
//
// It only ever sets up a new store: the batch is guarded so it never rewrites
// a store that took an order or whose markets the merchant already edited
// (the backup market is still the one migration 0112 created, revision 1, and
// it is the only market). Everything stays editable in Settings afterwards.
// It creates no tax region and no shipping zone; the home setup guide says
// what to do next.
import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
    BACKUP_MARKET_ID,
    inventoryLocations,
    marketCountries,
    marketPresences,
    markets,
    orders,
    products,
    shippingMethods,
} from "@scalius/database/schema";
import { backupMarketSetupWrites } from "../markets";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { isValidTimeZone } from "@scalius/shared/commerce-time";
import { normalizeSupportedCurrencyCode, type SupportedCurrencyCode } from "@scalius/shared/currency";
import { defaultPriceIncrementMinor } from "@scalius/shared/currency-policy";
import { getCountries } from "@scalius/shared/customer-utils";
import { toHandle } from "@scalius/shared/handle";
import { MARKET_HANDLE_MAX_LENGTH, MARKET_LOCALE_PATTERN, MARKET_NAME_MAX_LENGTH } from "@scalius/shared/markets";
import {
    SYSTEM_WEIGHT_UNITS,
    isUnitSystem,
    isWeightUnit,
    type UnitSystem,
    type WeightUnit,
} from "@scalius/shared/store-defaults";
import {
    defaultCurrencyForCountry,
    defaultCurrencySymbol,
    defaultUnitSystemForCountry,
} from "@scalius/shared/store-country-defaults";
import { AppError, ConflictError, ValidationError } from "@scalius/core/errors";
import {
    businessDocument,
    currencyDocument,
} from "../settings";
import { platformDocument, storeDefaultsOf } from "../platform";
import {
    selectSettingsDocuments,
    writeSettingsDocuments,
    type SettingsStoreKv,
} from "../../settings-store";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** The batch guard's marker when the store is no longer new. */
export const STORE_SETUP_DONE = "store_setup_done";
/** A store name's length (the business name field and the market name share it). */
export const STORE_NAME_MAX_LENGTH = 120;

const KNOWN_COUNTRIES: ReadonlySet<string> = new Set(getCountries());

/** Why setup is done, or null while the store is new. */
export type StoreSetupDoneReason = "has_orders" | "markets_configured";

export interface StoreSetupValues {
    storeName: string;
    /** ISO 3166-1 alpha-2. */
    countryCode: string;
    currencyCode: SupportedCurrencyCode;
    /** The storefront's language: the root presence's (two letters). */
    locale: string;
    timeZone: string;
    unitSystem: UnitSystem;
    weightUnit: WeightUnit;
}

export interface StoreSetupStatus {
    /** True while the store is new: no order, and the backup market as created. */
    needed: boolean;
    /** The backup market's price increment now (minor units). */
    priceIncrementMinor: number | null;
    done: StoreSetupDoneReason | null;
    /** What the store has now (the form starts from it). */
    current: StoreSetupValues;
    /** The primary market names a country. False: it sells everywhere, and `current.countryCode` is only the form's starting point. */
    countryConfigured: boolean;
    /** Products or delivery methods exist: their prices are in the current currency, which then cannot change. */
    currencyLocked: boolean;
}

export interface StoreSetupInput {
    storeName: string;
    countryCode: string;
    /** Absent: the country's currency (CLDR). */
    currencyCode?: string;
    /** Absent: the current root language. */
    locale?: string;
    timeZone: string;
    /** Absent: the country's system (CLDR). */
    unitSystem?: string;
    /** Absent: the system's default unit (kilograms, pounds). */
    weightUnit?: string;
}

/** A country's English name ("Bangladesh"): the business address's country field holds a name. */
function countryNameOf(code: string): string {
    try {
        return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
    } catch {
        return code;
    }
}

/** The SQL condition "this store is new": no order, the backup market untouched and alone. */
function storeIsNewSql() {
    return sql`NOT EXISTS (SELECT 1 FROM ${orders})
        AND EXISTS (SELECT 1 FROM ${markets} WHERE ${markets.id} = ${BACKUP_MARKET_ID} AND ${markets.revision} = 1)
        AND (SELECT count(*) FROM ${markets}) = 1`;
}

/** Reads what the store has now and whether setup still applies. */
export async function getStoreSetupStatus(db: Database): Promise<StoreSetupStatus> {
    const [stateRows, marketRows, countryRows, presenceRows, documentRows] = await safeBatch(db, [
        db.select({
            hasOrders: sql<number>`EXISTS (SELECT 1 FROM ${orders})`,
            marketCount: sql<number>`(SELECT count(*) FROM ${markets})`,
            currencyLocked: sql<number>`EXISTS (SELECT 1 FROM ${products}) OR EXISTS (SELECT 1 FROM ${shippingMethods})`,
        }).from(sql`(SELECT 1 AS one) AS store_setup_state`),
        db.select({ name: markets.name, revision: markets.revision, priceIncrementMinor: markets.priceIncrementMinor }).from(markets).where(sql`${markets.id} = ${BACKUP_MARKET_ID}`),
        db.select({ countryCode: marketCountries.countryCode }).from(marketCountries)
            .where(sql`${marketCountries.marketId} = ${BACKUP_MARKET_ID}`).orderBy(marketCountries.countryCode),
        db.select({ locale: marketPresences.locale }).from(marketPresences)
            .where(sql`${marketPresences.marketId} = ${BACKUP_MARKET_ID} AND ${marketPresences.kind} = 'subfolder' AND ${marketPresences.value} = ''`),
        selectSettingsDocuments(db, [businessDocument, currencyDocument, platformDocument]),
    ] as never) as unknown as [
        Array<{ hasOrders: number; marketCount: number; currencyLocked: number }>,
        Array<{ name: string; revision: number; priceIncrementMinor: number | null }>,
        Array<{ countryCode: string }>,
        Array<{ locale: string }>,
        Array<{ category: string; value: string; revision: number }>,
    ];
    const [business, currency, platform] = await Promise.all([
        businessDocument.fromRows(documentRows),
        currencyDocument.fromRows(documentRows),
        platformDocument.fromRows(documentRows),
    ]);
    const state = stateRows[0];
    const backup = marketRows[0];
    const hasOrders = Boolean(Number(state?.hasOrders ?? 0));
    const marketsConfigured = !backup || backup.revision !== 1 || Number(state?.marketCount ?? 0) !== 1;
    const done: StoreSetupDoneReason | null = hasOrders ? "has_orders" : marketsConfigured ? "markets_configured" : null;
    return {
        needed: done === null,
        priceIncrementMinor: backup?.priceIncrementMinor ?? null,
        done,
        countryConfigured: countryRows.length > 0,
        current: {
            storeName: business.value.companyName,
            countryCode: countryRows[0]?.countryCode ?? "BD",
            currencyCode: currency.value.currencyCode,
            locale: presenceRows[0]?.locale ?? "en",
            ...storeDefaultsOf(platform.value),
        },
        currencyLocked: Boolean(Number(state?.currencyLocked ?? 0)),
    };
}

/** The complete, validated setup a request asks for. */
export function resolveStoreSetup(input: StoreSetupInput, current: StoreSetupValues): StoreSetupValues {
    const storeName = input.storeName.trim();
    if (!storeName) throw new ValidationError("Enter your store's name.");
    if (storeName.length > STORE_NAME_MAX_LENGTH) throw new ValidationError(`A store name is at most ${STORE_NAME_MAX_LENGTH} characters.`);
    const countryCode = input.countryCode.trim().toUpperCase();
    if (!KNOWN_COUNTRIES.has(countryCode)) throw new ValidationError("Choose your store's country or region.");
    const currencyCode = input.currencyCode === undefined
        ? defaultCurrencyForCountry(countryCode)
        : normalizeSupportedCurrencyCode(input.currencyCode);
    if (!currencyCode) throw new ValidationError("Select a supported three-letter currency code.");
    const locale = (input.locale ?? current.locale).trim().toLowerCase();
    if (!MARKET_LOCALE_PATTERN.test(locale)) throw new ValidationError("Choose your store's language.");
    const timeZone = input.timeZone.trim();
    if (!isValidTimeZone(timeZone)) throw new ValidationError("Choose a time zone from the list, such as Europe/London.");
    const unitSystem = input.unitSystem ?? defaultUnitSystemForCountry(countryCode);
    if (!isUnitSystem(unitSystem)) throw new ValidationError("Choose the metric or the imperial system.");
    const weightUnit = input.weightUnit ?? SYSTEM_WEIGHT_UNITS[unitSystem][0]!;
    if (!isWeightUnit(weightUnit) || !SYSTEM_WEIGHT_UNITS[unitSystem].includes(weightUnit)) {
        throw new ValidationError(`Choose a weight unit of the ${unitSystem} system: ${SYSTEM_WEIGHT_UNITS[unitSystem].join(" or ")}.`);
    }
    return { storeName, countryCode, currencyCode, locale, timeZone, unitSystem, weightUnit };
}

export interface StoreSetupResult {
    values: StoreSetupValues;
    /** The backup market's price increment changed: catalogue projections need a rebuild. */
    priceIncrementChanged: boolean;
}

/**
 * Sets up a new store in one batch. A store that is no longer new is a 409
 * (`store_setup_done`) and nothing is written; the same request sent twice
 * therefore answers 409 the second time, with the store as the first one left it.
 */
export async function applyStoreSetup(
    db: Database,
    input: StoreSetupInput,
    kv?: SettingsStoreKv | null,
): Promise<StoreSetupResult> {
    const status = await getStoreSetupStatus(db);
    if (!status.needed) throw storeSetupDone();
    const values = resolveStoreSetup(input, status.current);
    if (status.currencyLocked && values.currencyCode !== status.current.currencyCode) {
        throw new ConflictError(`Products or delivery methods are priced in ${status.current.currencyCode}, so the currency can't change here. Change it in Settings → Store details after removing them.`);
    }

    const marketName = countryNameOf(values.countryCode).slice(0, MARKET_NAME_MAX_LENGTH).trim() || values.countryCode;
    const handle = (toHandle(marketName) || values.countryCode.toLowerCase()).slice(0, MARKET_HANDLE_MAX_LENGTH).replace(/-+$/, "")
        || values.countryCode.toLowerCase();
    const increment = defaultPriceIncrementMinor(values.currencyCode);
    const guard = buildBatchGuard(db, storeIsNewSql(), STORE_SETUP_DONE) as SQLiteBatchItem;
    const marketWrites = backupMarketSetupWrites(db, {
        name: marketName,
        handle,
        countryCode: values.countryCode,
        locale: values.locale,
        priceIncrementMinor: increment,
    });
    const currencyChanged = values.currencyCode !== status.current.currencyCode;

    try {
        await writeSettingsDocuments(db, [
            {
                document: businessDocument,
                patch: { companyName: values.storeName, country: countryNameOf(values.countryCode) },
            },
            ...currencyChanged
                ? [{
                    document: currencyDocument,
                    patch: { currencyCode: values.currencyCode, currencySymbol: defaultCurrencySymbol(values.currencyCode) },
                }]
                : [],
            {
                document: platformDocument,
                patch: { timeZone: values.timeZone, unitSystem: values.unitSystem, weightUnit: values.weightUnit },
                ctx: { kv },
            },
        ], {
            before: [guard],
            after: [
                ...marketWrites,
                // The default location is in the store's country while nobody has
                // edited it (MARKETS-DESIGN step 5): tax origin and shipping read it.
                db.update(inventoryLocations).set({ countryCode: values.countryCode, updatedAt: sql`unixepoch()` })
                    .where(sql`${inventoryLocations.isDefault} = 1 AND ${inventoryLocations.version} = 1
                        AND ${inventoryLocations.addressLine1} IS NULL AND ${inventoryLocations.city} IS NULL
                        AND ${inventoryLocations.postalCode} IS NULL`) as SQLiteBatchItem,
            ],
        });
    } catch (error) {
        if (isBatchGuardError(error, STORE_SETUP_DONE)) throw storeSetupDone();
        throw error;
    }
    // Migration 0112 gave the backup market BDT's whole-taka increment; a
    // currency priced in cents changes every stored card price.
    return { values, priceIncrementChanged: increment !== status.priceIncrementMinor };
}

function storeSetupDone(): AppError {
    return new AppError(409, STORE_SETUP_DONE, "This store is already set up. Change these details in Settings → Store details and Settings → Markets.");
}
