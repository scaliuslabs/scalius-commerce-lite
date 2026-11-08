// Store setting reads in the stable app API (operation-registry/README.md),
// mounted at /admin/resources: the store's markets, shipping zones, tax
// regions and a bounded sales summary, for apps that quote, price or report
// (a shipping-rate or tax app, a multi-currency pricing app, a dashboard
// widget). Every operation is a read of what the dashboard's settings pages
// and reports already compute (core `markets`, `delivery`, `tax` and
// `analytics`); none duplicates their rules.
//
//   - `markets.*` (read_settings, settings.general.view): `MarketResource`.
//   - `shipping_zones.*` (read_settings, settings.shipping_methods.view):
//     `ShippingZoneResource`, delivery zones and, as one more zone of kind
//     `pickup`, the store's local pickup points.
//   - `tax_regions.*` (read_settings, taxes.view): `TaxRegionResource`.
//   - `analytics.get_summary` (read_analytics, dashboard.analytics):
//     `AnalyticsSummary`, one overview query for the period.
//
// Money is integer minor units of the `currency` beside it; instants are ISO
// 8601; every resource exposes `revision` where its row has a version.
import { createRoute, z } from "@hono/zod-openapi";
import { asc } from "drizzle-orm";
import { adminRouter } from "./admin-router";
import type { MiddlewareHandler } from "hono";
import { shippingProfileRates, taxClasses, taxRates } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { createAnalyticsContext, getAnalyticsOverview, type SalesMeasures } from "@scalius/core/modules/analytics";
import { listDeliveryZones, type DeliveryRateView, type DeliveryZoneView } from "@scalius/core/modules/delivery";
import { listMarkets, readStoreCurrency, type MarketRecord } from "@scalius/core/modules/markets";
import { getTaxSettingsDocument, listTaxRegions, type TaxRegionRecord } from "@scalius/core/modules/tax";
import { inJsonArray } from "@scalius/core/utils/in-json-array";
import {
  ANALYTICS_GRANULARITIES,
  ANALYTICS_MAX_DAY_BUCKETS,
  analyticsGranularities,
  analyticsRangeDays,
  defaultAnalyticsGranularity,
  validateAnalyticsRange,
  type AnalyticsGranularity,
} from "@scalius/shared/analytics-period";
import { commerceCalendarDateKey, commerceDayStart, shiftCommerceCalendarDateKey } from "@scalius/shared/commerce-time";
import { MAX_MARKETS, MAX_MARKET_COUNTRIES } from "@scalius/shared/markets";
import { ok } from "../../utils/api-response";
import { NotFoundError, ValidationError } from "../../utils/api-error";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { isoTimestampSchema, nullableIsoTimestampSchema } from "../../schemas/timestamps";
import { boundedPage, boundedPageQuery, nextCursorSchema } from "../../utils/bounded-page";
import { storeTimeZoneOf } from "../../utils/store-time-zone";

const app = adminRouter();

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
};
app.use("*", noStore);

const readResponses = { 400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404], 429: errorResponses[429], 500: errorResponses[500] };
const idParam = z.object({ id: z.string().min(1).max(180) });

/** The most a page holds in JSON before it stops early: an app or agent result is 64 KiB. */
const PAGE_BYTE_BUDGET = 56 * 1024;
const encoder = new TextEncoder();

type PageOptions<R> = Parameters<typeof boundedPage<R>>[1];

/**
 * One page of a list read whole, cut by cursor (`boundedPage`), then read into
 * what each record answers (`load`, one batched read for the page) and
 * shortened, never emptied, to fit the response budget: a page that stops
 * early names the cursor of its last item.
 */
async function loadedPage<R, T>(
  records: readonly R[],
  options: PageOptions<R>,
  load: (page: R[]) => Promise<T[]> | T[],
): Promise<{ items: T[]; nextCursor: string | null }> {
  const window = boundedPage(records, options);
  const items = await load(window.items);
  let bytes = 0;
  let fit = 0;
  for (const item of items) {
    const size = encoder.encode(JSON.stringify(item)).byteLength + 1;
    if (fit > 0 && bytes + size > PAGE_BYTE_BUDGET) break;
    bytes += size;
    fit += 1;
  }
  if (fit === items.length) return { items, nextCursor: window.nextCursor };
  return { items: items.slice(0, fit), nextCursor: boundedPage(records, { ...options, limit: fit }).nextCursor };
}

/** Code-unit order: the order `boundedPage` compares cursor values in. */
function byKey<T>(key: (item: T) => string, id: (item: T) => string) {
  return (left: T, right: T) => {
    const a = key(left);
    const b = key(right);
    if (a !== b) return a < b ? -1 : 1;
    const x = id(left);
    const y = id(right);
    return x === y ? 0 : x < y ? -1 : 1;
  };
}

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(0).toISOString());
const nullableIso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);

// ─── Markets ────────────────────────────────────────────────────────────────

const MarketResource = z.object({
  id: z.string(),
  handle: z.string(),
  name: z.string(),
  status: z.enum(["draft", "active"]).openapi({ description: "Only an active market resolves for buyers." }),
  isBackup: z.boolean().openapi({ description: "The backup market catches every buyer no other market matches, sells in the shop currency and holds the root URL." }),
  revision: z.number().int().positive(),
  countries: z.array(z.string().length(2)).max(MAX_MARKET_COUNTRIES).openapi({ description: "ISO 3166-1 alpha-2 codes, sorted. A country belongs to one market." }),
  presence: z.object({
    value: z.string().max(5).openapi({ description: "The URL subfolder (`en-in`), or `''` for the root URL, which only the backup market holds." }),
    locale: z.string().length(2).openapi({ description: "The language of the presence's pages (ISO 639-1)." }),
  }).nullable().openapi({ description: "Its web presence; null when it has none." }),
  currency: z.string().length(3).openapi({ description: "The currency it sells in: its own, else the shop currency." }),
  shopCurrency: z.string().length(3).openapi({ description: "The store currency: the books' currency, which every other amount in the API is in." }),
  ownCurrency: z.boolean().openapi({ description: "True when it sells in its own currency, priced from the shop prices at its exchange rate unless a price list fixes them." }),
  priceMode: z.enum(["fixed", "fx"]).openapi({ description: "`fixed`: product prices and its fixed price lists. `fx`: product prices converted at `fxRate`, adjusted, rounded up and ending as set." }),
  fxRate: z.string().nullable().openapi({ description: "Units of `currency` per unit of `shopCurrency` (an exact decimal); null: none yet. A market in the shop currency converts at 1." }),
  fxRateAsOf: nullableIsoTimestampSchema.openapi({ description: "When the rate was last set." }),
  fxRateSource: z.string().openapi({ description: "Who sets the rate: `manual` or an exchange rate app's provider (`<app id>:<provider id>`)." }),
  fxLockMinutes: z.number().int().openapi({ description: "Minutes after placement an unpaid foreign-currency order may start a new payment session; placed amounts never change." }),
  priceAdjustmentBps: z.number().int().openapi({ description: "Raises (positive) or lowers (negative) FX-derived prices, in basis points." }),
  priceRoundingMinor: z.number().int().nullable().openapi({ description: "FX-derived prices round up to this step, in minor units of `currency`; null: the price increment." }),
  priceEndingMinor: z.number().int().nullable().openapi({ description: "What a rounded price ends in within its step, in minor units of `currency`; null for none." }),
  priceIncrementMinor: z.number().int().positive().openapi({ description: "The step its prices move in, in minor units of `currency`." }),
  priceIncrementInherited: z.boolean(),
  pricesIncludeTax: z.boolean().openapi({ description: "Whether its prices include tax: checkout shows tax as included when true and adds it on top when false." }),
  hasOrders: z.boolean().openapi({ description: "A market that took orders is never deleted." }),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).openapi("MarketResource");

function marketResource(market: MarketRecord): z.infer<typeof MarketResource> {
  return {
    id: market.id,
    handle: market.handle,
    name: market.name,
    status: market.status,
    isBackup: market.isBackup,
    revision: market.revision,
    countries: market.countries,
    presence: market.presence ? { value: market.presence.value, locale: market.presence.locale } : null,
    currency: market.currencyCode,
    shopCurrency: market.shopCurrencyCode,
    ownCurrency: market.ownCurrency,
    priceMode: market.priceMode,
    fxRate: market.fxRate,
    fxRateAsOf: nullableIso(market.fxRateAsOf),
    fxRateSource: market.fxRateSource,
    fxLockMinutes: market.fxLockMinutes,
    priceAdjustmentBps: market.priceAdjustmentBps,
    priceRoundingMinor: market.priceRoundingMinor,
    priceEndingMinor: market.priceEndingMinor,
    priceIncrementMinor: market.priceIncrementMinor,
    priceIncrementInherited: market.priceIncrementInherited,
    pricesIncludeTax: market.pricesIncludeTax,
    hasOrders: market.hasOrders,
    createdAt: iso(market.createdAt),
    updatedAt: iso(market.updatedAt),
  };
}

/** Markets in the dashboard's order: the backup market first, then by name. */
async function readMarkets(db: Database): Promise<z.infer<typeof MarketResource>[]> {
  return (await listMarkets(db))
    .map(marketResource)
    .sort(byKey<z.infer<typeof MarketResource>>((market) => `${market.isBackup ? 0 : 1}:${market.name}`, (market) => market.id));
}

app.openapi(createRoute({
  operationId: "dashboard.resources.markets.list",
  method: "get",
  path: "/markets",
  tags: ["App API - Markets"],
  summary: "List the store's markets, the backup market first",
  description: "Each market with its countries, selling currency, price adjustment and rounding facts, web presence and locale, and status. A buyer belongs to the active market of their country, else the backup market. At most 50 markets; the default page holds them all.",
  request: { query: z.object(boundedPageQuery(MAX_MARKETS)) },
  responses: {
    200: { description: "Markets", content: { "application/json": { schema: successEnvelope(z.object({ markets: z.array(MarketResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const markets = await readMarkets(c.get("db"));
  const page = await loadedPage(markets, {
    name: "markets",
    cursor: query.cursor,
    limit: query.limit,
    id: (market) => market.id,
    sort: { kind: "text", value: (market) => `${market.isBackup ? 0 : 1}:${market.name}` },
  }, (items) => items);
  return ok(c, { markets: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.markets.get",
  method: "get",
  path: "/markets/{id}",
  tags: ["App API - Markets"],
  summary: "Get one market",
  request: { params: idParam },
  responses: {
    200: { description: "The market", content: { "application/json": { schema: successEnvelope(z.object({ market: MarketResource })) } } },
    ...readResponses,
  },
}), async (c) => {
  const { id } = c.req.valid("param");
  const market = (await readMarkets(c.get("db"))).find((candidate) => candidate.id === id);
  if (!market) throw new NotFoundError("Market not found");
  return ok(c, { market });
});

// ─── Shipping zones ─────────────────────────────────────────────────────────

const ShippingRate = z.object({
  id: z.string(),
  kind: z.enum(["delivery", "pickup"]),
  name: z.string().openapi({ description: "What the buyer sees." }),
  feeMinor: z.number().int().openapi({ description: "The charge, in minor units of the zone's `currency` (converted at the order's locked market rate in another currency)." }),
  freeOverMinor: z.number().int().nullable().openapi({ description: "The order value from which the charge is waived, in minor units; null: never waived." }),
  rateSource: z.string().openapi({ description: "`flat` (the fee above) or a courier app's rate provider (`<app id>:<provider id>`), which quotes at checkout and falls back to `fallbackFeeMinor`." }),
  rateService: z.string().nullable().openapi({ description: "The courier service a provider quotes." }),
  fallbackFeeMinor: z.number().int().nullable(),
  description: z.string().nullable(),
  pickupAddress: z.string().nullable().openapi({ description: "Where a buyer collects the order (kind `pickup`)." }),
  pickupHours: z.string().nullable(),
  isActive: z.boolean().openapi({ description: "Only an active rate is offered at checkout." }),
  profileRates: z.array(z.object({
    profileId: z.string().openapi({ description: "The shipping profile whose items these rates price." }),
    feeMinor: z.number().int(),
    minWeightGrams: z.number().int().nullable(),
    maxWeightGrams: z.number().int().nullable(),
    minSubtotalMinor: z.number().int().nullable(),
    maxSubtotalMinor: z.number().int().nullable(),
    freeOverMinor: z.number().int().nullable(),
  })).openapi({ description: "The profile-specific rates behind this option: a profile's items pay the cheapest one whose weight and value bounds hold; items of a profile without one pay `feeMinor`." }),
}).openapi("ShippingRate");

const ShippingZoneResource = z.object({
  id: z.string().openapi({ description: "The zone's id; the store's local pickup points are the one zone with id `pickup`." }),
  name: z.string(),
  kind: z.enum(["delivery", "pickup"]),
  revision: z.number().int().nonnegative().openapi({ description: "Advances on every edit of the zone; local pickup is 0 until the merchant first saves it." }),
  currency: z.string().length(3).openapi({ description: "The store currency: every `*Minor` amount of the zone is in it." }),
  regions: z.array(z.object({
    countryCode: z.string().length(2),
    scope: z.enum(["country", "admin_area", "postal_prefix"]),
    adminArea: z.string().nullable().openapi({ description: "An admin area of the country's address rules (state, province, division)." }),
    postalPrefix: z.string().nullable().openapi({ description: "Postal codes that start with these letters and digits, spaces and dashes ignored." }),
  })).openapi({ description: "Where the zone delivers. A region belongs to one zone." }),
  places: z.array(z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(["city", "zone", "area"]),
    parentName: z.string().nullable(),
  })).openapi({ description: "Bangladesh delivery places (city, thana, area) the zone serves. A place belongs to one zone." }),
  rates: z.array(ShippingRate),
}).openapi("ShippingZoneResource");

type ShippingZone = z.infer<typeof ShippingZoneResource>;
type ShippingRateData = z.infer<typeof ShippingRate>;
type ProfileRateRows = Map<string, ShippingRateData["profileRates"]>;

const PICKUP_ZONE_ID = "pickup";

function rateResource(rate: DeliveryRateView, profileRates: ProfileRateRows): ShippingRateData {
  // `listDeliveryZones(db, 0)` converts nothing: with no decimals its "major" amounts are the stored minor units.
  return {
    id: rate.id,
    kind: rate.kind,
    name: rate.name,
    feeMinor: rate.fee,
    freeOverMinor: rate.freeOver,
    rateSource: rate.rateSource,
    rateService: rate.rateService,
    fallbackFeeMinor: rate.fallbackFee,
    description: rate.description,
    pickupAddress: rate.pickupAddress,
    pickupHours: rate.pickupHours,
    isActive: rate.isActive,
    profileRates: profileRates.get(rate.id) ?? [],
  };
}

function zoneResource(zone: DeliveryZoneView, currency: string, profileRates: ProfileRateRows): ShippingZone {
  return {
    id: zone.id,
    name: zone.name,
    kind: "delivery",
    revision: zone.revision,
    currency,
    regions: zone.regions.map((region) => ({
      countryCode: region.countryCode,
      scope: region.postalPrefix ? "postal_prefix" : region.adminArea ? "admin_area" : "country",
      adminArea: region.adminArea,
      postalPrefix: region.postalPrefix,
    })),
    places: zone.locations.map((place) => ({ id: place.id, name: place.name, type: place.type, parentName: place.parentName })),
    rates: zone.rates.map((rate) => rateResource(rate, profileRates)),
  };
}

/** Delivery zones by name, then the store's local pickup points as the last zone. */
async function readShippingZones(db: Database): Promise<ShippingZone[]> {
  const [{ code: currency }, view, bands] = await Promise.all([
    readStoreCurrency(db),
    listDeliveryZones(db, 0),
    db.select().from(shippingProfileRates).orderBy(asc(shippingProfileRates.sortOrder), asc(shippingProfileRates.id)),
  ]);
  const profileRates: ProfileRateRows = new Map();
  for (const band of bands) {
    const rows = profileRates.get(band.methodId) ?? [];
    rows.push({
      profileId: band.profileId,
      feeMinor: band.feeMinor,
      minWeightGrams: band.minWeightGrams ?? null,
      maxWeightGrams: band.maxWeightGrams ?? null,
      minSubtotalMinor: band.minSubtotalMinor ?? null,
      maxSubtotalMinor: band.maxSubtotalMinor ?? null,
      freeOverMinor: band.freeOverMinor ?? null,
    });
    profileRates.set(band.methodId, rows);
  }
  const zones = view.zones
    .map((zone) => zoneResource(zone, currency, profileRates))
    .sort(byKey<ShippingZone>((zone) => zone.name, (zone) => zone.id));
  const pickup: ShippingZone = {
    id: PICKUP_ZONE_ID,
    name: "Local pickup",
    kind: "pickup",
    revision: view.pickup.revision,
    currency,
    regions: [],
    places: [],
    rates: view.pickup.rates.map((rate) => rateResource(rate, profileRates)),
  };
  return [...zones, pickup];
}

const zoneSortKey = (zone: ShippingZone) => `${zone.kind === "pickup" ? 1 : 0}:${zone.name}`;

app.openapi(createRoute({
  operationId: "dashboard.resources.shipping_zones.list",
  method: "get",
  path: "/shipping-zones",
  tags: ["App API - Shipping"],
  summary: "List delivery zones with their rates, and local pickup",
  description: "Each delivery zone with the countries, admin areas, postal prefixes and Bangladesh places it serves and its rates (minor units of the store currency, free-over threshold, courier rate source and profile rates), then one last zone of kind `pickup` for the store's pickup points. A destination takes its most specific zone: a Bangladesh place (area, then thana, then city) beats a postal prefix (the longest wins), which beats an admin area, which beats the whole country; none matching means no delivery. Zones list by name; a page may hold fewer zones than `limit` to stay within the response budget.",
  request: {
    query: z.object({
      cursor: z.string().max(1024).optional().openapi({ description: "The `nextCursor` of the page before; leave it out for the first page." }),
      limit: z.coerce.number().int().min(1).max(50).default(20).openapi({ description: "At most this many zones (default 20, maximum 50)." }),
    }),
  },
  responses: {
    200: { description: "Shipping zones", content: { "application/json": { schema: successEnvelope(z.object({ shippingZones: z.array(ShippingZoneResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const zones = (await readShippingZones(c.get("db"))).sort(byKey<ShippingZone>(zoneSortKey, (zone) => zone.id));
  const page = await loadedPage(zones, {
    name: "shipping_zones",
    cursor: query.cursor,
    limit: query.limit,
    id: (zone) => zone.id,
    sort: { kind: "text", value: zoneSortKey },
  }, (items) => items);
  return ok(c, { shippingZones: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.shipping_zones.get",
  method: "get",
  path: "/shipping-zones/{id}",
  tags: ["App API - Shipping"],
  summary: "Get one shipping zone, or local pickup",
  description: "A delivery zone by id, or the store's pickup points as zone `pickup`.",
  request: { params: idParam },
  responses: {
    200: { description: "The shipping zone", content: { "application/json": { schema: successEnvelope(z.object({ shippingZone: ShippingZoneResource })) } } },
    ...readResponses,
  },
}), async (c) => {
  const { id } = c.req.valid("param");
  const zone = (await readShippingZones(c.get("db"))).find((candidate) => candidate.id === id);
  if (!zone) throw new NotFoundError("Shipping zone not found");
  return ok(c, { shippingZone: zone });
});

// ─── Tax regions ────────────────────────────────────────────────────────────

const TaxRegionResource = z.object({
  id: z.string(),
  countryCode: z.string().length(2),
  kind: z.enum(["country", "admin_area", "postal_prefix", "place"]).openapi({ description: "`country` is the registration: where the store collects tax. The others are regions of a registered country; the most specific region with rates of a line's class applies, and broader regions add only through `combinable` rates." }),
  adminArea: z.string().nullable(),
  postalPrefix: z.string().nullable(),
  place: z.object({
    id: z.string(),
    type: z.enum(["city", "zone", "area"]),
    name: z.string().nullable(),
  }).nullable().openapi({ description: "A Bangladesh delivery place (kind `place`)." }),
  providerId: z.string().nullable().openapi({ description: "A country's tax provider (`<app id>:<provider id>`); null uses the store-wide one, `system` being the rates below." }),
  revision: z.number().int().positive(),
  taxEnabled: z.boolean().openapi({ description: "Whether the store collects tax at all." }),
  taxShipping: z.boolean().openapi({ description: "Whether delivery charges are taxed." }),
  rates: z.array(z.object({
    id: z.string(),
    name: z.string(),
    taxClass: z.object({
      id: z.string(),
      name: z.string(),
      isExempt: z.boolean().openapi({ description: "Products of an exempt class pay no tax." }),
    }).openapi({ description: "The tax class the rate applies to." }),
    rateBps: z.number().int().openapi({ description: "The rate in basis points: 1500 is 15.00%." }),
    priority: z.number().int().openapi({ description: "Lower first; a compound rate applies on top of the tax before it." }),
    isCompound: z.boolean(),
    combinable: z.boolean().openapi({ description: "Applies together with the broader regions' rates of its class instead of replacing them." }),
    isActive: z.boolean(),
    revision: z.number().int().positive(),
  })).openapi({ description: "Whether prices include the tax is each market's `pricesIncludeTax`, not the region's." }),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).openapi("TaxRegionResource");

type TaxRegionData = z.infer<typeof TaxRegionResource>;

const REGION_RANK = { country: 0, admin_area: 1, postal_prefix: 2, place: 3 } as const;

/** The regions as apps read them: their rates, the classes the rates apply to and the store's tax switches. */
async function taxRegionResources(db: Database, regions: readonly TaxRegionRecord[]): Promise<TaxRegionData[]> {
  if (regions.length === 0) return [];
  const [settings, rates] = await Promise.all([
    getTaxSettingsDocument(db),
    db.select().from(taxRates).where(inJsonArray(taxRates.taxRegionId, regions.map((region) => region.id)))
      .orderBy(asc(taxRates.priority), asc(taxRates.id)),
  ]);
  const classIds = [...new Set(rates.map((rate) => rate.taxClassId))];
  const classes = new Map((classIds.length === 0 ? [] : await db.select({ id: taxClasses.id, name: taxClasses.name, isExempt: taxClasses.isExempt })
    .from(taxClasses).where(inJsonArray(taxClasses.id, classIds))).map((row) => [row.id, row]));
  return regions.map((region) => ({
    id: region.id,
    countryCode: region.countryCode,
    kind: region.kind,
    adminArea: region.adminArea,
    postalPrefix: region.postalPrefix,
    place: region.placeId && region.placeType ? { id: region.placeId, type: region.placeType, name: region.placeName } : null,
    providerId: region.providerId,
    revision: region.version,
    taxEnabled: settings.enabled,
    taxShipping: settings.taxShipping,
    rates: rates.filter((rate) => rate.taxRegionId === region.id).map((rate) => ({
      id: rate.id,
      name: rate.name,
      taxClass: {
        id: rate.taxClassId,
        name: classes.get(rate.taxClassId)?.name ?? rate.taxClassId,
        isExempt: classes.get(rate.taxClassId)?.isExempt ?? false,
      },
      rateBps: rate.rateBps,
      priority: rate.priority,
      isCompound: rate.isCompound,
      combinable: rate.combinable,
      isActive: rate.isActive,
      revision: rate.version,
    })),
    createdAt: iso(region.createdAt),
    updatedAt: iso(region.updatedAt),
  }));
}

const regionSortKey = (region: TaxRegionRecord) => `${region.countryCode}:${REGION_RANK[region.kind]}`;

app.openapi(createRoute({
  operationId: "dashboard.resources.tax_regions.list",
  method: "get",
  path: "/tax-regions",
  tags: ["App API - Tax"],
  summary: "List where the store collects tax, with each region's rates",
  description: "Each tax region (a registered country, then its admin areas, postal prefixes and Bangladesh places) with its rates in basis points, the tax class each applies to and whether it is compound or combinable. Regions match like shipping zones, most specific first; no region means no tax. Listed by country, then country before admin area, postal prefix and place.",
  request: {
    query: z.object({
      cursor: z.string().max(1024).optional().openapi({ description: "The `nextCursor` of the page before; leave it out for the first page." }),
      limit: z.coerce.number().int().min(1).max(100).default(50).openapi({ description: "At most this many regions (default 50, maximum 100); a page may hold fewer to stay within the response budget." }),
      countryCode: z.string().trim().length(2).optional().openapi({ description: "Only this country's regions (ISO 3166-1 alpha-2)." }),
    }),
  },
  responses: {
    200: { description: "Tax regions", content: { "application/json": { schema: successEnvelope(z.object({ taxRegions: z.array(TaxRegionResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const records = (await listTaxRegions(db, query.countryCode ? { countryCode: query.countryCode } : {}))
    .sort(byKey<TaxRegionRecord>(regionSortKey, (region) => region.id));
  // Cut the cheap records first; only the page's regions read their rates.
  const page = await loadedPage(records, {
    name: "tax_regions",
    cursor: query.cursor,
    limit: query.limit,
    id: (region) => region.id,
    sort: { kind: "text", value: regionSortKey },
  }, (items) => taxRegionResources(db, items));
  return ok(c, { taxRegions: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.tax_regions.get",
  method: "get",
  path: "/tax-regions/{id}",
  tags: ["App API - Tax"],
  summary: "Get one tax region with its rates",
  request: { params: idParam },
  responses: {
    200: { description: "The tax region", content: { "application/json": { schema: successEnvelope(z.object({ taxRegion: TaxRegionResource })) } } },
    ...readResponses,
  },
}), async (c) => {
  const { id } = c.req.valid("param");
  const db = c.get("db");
  const record = (await listTaxRegions(db)).find((candidate) => candidate.id === id);
  if (!record) throw new NotFoundError("Tax region not found");
  const [taxRegion] = await taxRegionResources(db, [record]);
  return ok(c, { taxRegion: taxRegion! });
});

// ─── Analytics summary ──────────────────────────────────────────────────────

/** The longest period a summary covers. */
const SUMMARY_MAX_DAYS = 366;

const SalesFigures = z.object({
  orders: z.number().int().openapi({ description: "Sales orders placed in the period, not counting cancelled or incomplete ones." }),
  grossSalesMinor: z.number().int().openapi({ description: "Merchandise at list price before discounts." }),
  discountsMinor: z.number().int(),
  refundsMinor: z.number().int().openapi({ description: "Merchandise returned or refunded on these orders, counted against the order's placement date." }),
  netSalesMinor: z.number().int().openapi({ description: "Gross sales minus discounts minus refunds." }),
  shippingMinor: z.number().int(),
  taxesMinor: z.number().int(),
  totalSalesMinor: z.number().int().openapi({ description: "Net sales plus shipping plus taxes." }),
  itemsSold: z.number().int().openapi({ description: "Units sold, net of returns." }),
  averageOrderValueMinor: z.number().int().openapi({ description: "(Gross sales minus discounts) divided by orders, rounded to the minor unit; 0 without orders." }),
}).openapi("AnalyticsFigures");

const AnalyticsSummary = z.object({
  currency: z.string().length(3).openapi({ description: "The store currency: every `*Minor` amount is in it." }),
  timeZone: z.string().openapi({ description: "The store's IANA time zone: days, weeks and months are calendar ones in it." }),
  from: isoTimestampSchema.openapi({ description: "The first instant covered: the start of the store day that holds the requested `from`." }),
  to: isoTimestampSchema.openapi({ description: "The end of the period, exclusive: the start of the store day after the one holding the requested `to` (less a millisecond)." }),
  granularity: z.enum(ANALYTICS_GRANULARITIES),
  totals: SalesFigures,
  otherCurrencyOrders: z.number().int().openapi({ description: "Orders placed in a currency other than the store's: counted here, summed nowhere." }),
  buckets: z.array(SalesFigures.extend({
    from: isoTimestampSchema.openapi({ description: "The bucket's first instant, clipped to the period." }),
    to: isoTimestampSchema.openapi({ description: "The bucket's end, exclusive." }),
  })).max(ANALYTICS_MAX_DAY_BUCKETS).openapi({ description: "One entry per day, week (store country's first weekday) or month of the period, zero-filled, in time order." }),
}).openapi("AnalyticsSummary");

function figures(measures: SalesMeasures): z.infer<typeof SalesFigures> {
  return {
    orders: measures.orders,
    grossSalesMinor: measures.grossSales,
    discountsMinor: measures.discounts,
    refundsMinor: measures.returns,
    netSalesMinor: measures.netSales,
    shippingMinor: measures.shipping,
    taxesMinor: measures.taxes,
    totalSalesMinor: measures.totalSales,
    itemsSold: measures.netItemsSold,
    averageOrderValueMinor: measures.averageOrderValue,
  };
}

app.openapi(createRoute({
  operationId: "dashboard.resources.analytics.get_summary",
  method: "get",
  path: "/analytics/summary",
  tags: ["App API - Analytics"],
  summary: "Sales summary for a period",
  description: "Orders, gross sales, discounts, refunds, net sales, shipping, taxes, total sales and average order value for a period of at most 366 days, in minor units of the store currency, with day, week or month buckets (day up to 92 days). The same figures as the dashboard's analytics overview, read in one query. The period is whole store-calendar days: `from` starts at the day holding it and `to` (exclusive) ends the day holding the instant before it; the answer names the exact instants covered. The store records no storefront sessions or visitors, so the summary carries none.",
  request: {
    query: z.object({
      from: z.string().datetime({ offset: true }).openapi({ description: "The start of the period (ISO 8601)." }),
      to: z.string().datetime({ offset: true }).openapi({ description: "The end of the period, exclusive (ISO 8601); at most 366 days after `from`." }),
      granularity: z.enum(ANALYTICS_GRANULARITIES).optional().openapi({ description: "Bucket size. Day needs a period of 92 days or less; omitted: day up to 92 days, week up to a year." }),
    }),
  },
  responses: {
    200: { description: "Sales summary", content: { "application/json": { schema: successEnvelope(z.object({ summary: AnalyticsSummary })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const timeZone = storeTimeZoneOf(c.env);
  const fromMs = Date.parse(query.from);
  const toMs = Date.parse(query.to);
  if (!(toMs > fromMs)) throw new ValidationError("`to` must be after `from`.");
  if (toMs - fromMs > SUMMARY_MAX_DAYS * 86_400_000) throw new ValidationError(`A summary covers at most ${SUMMARY_MAX_DAYS} days.`);
  const first = commerceCalendarDateKey(timeZone, fromMs);
  const last = commerceCalendarDateKey(timeZone, toMs - 1);
  let range: ReturnType<typeof validateAnalyticsRange>;
  try {
    range = validateAnalyticsRange({ from: first, to: last });
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "Invalid period.");
  }
  if (analyticsRangeDays(range) > SUMMARY_MAX_DAYS) throw new ValidationError(`A summary covers at most ${SUMMARY_MAX_DAYS} store days.`);
  const allowed = analyticsGranularities(range);
  if (query.granularity && !allowed.includes(query.granularity)) {
    throw new ValidationError("Day buckets cover at most 92 days; use week or month for a longer period.");
  }
  const granularity: AnalyticsGranularity = query.granularity ?? defaultAnalyticsGranularity(range);
  const ctx = await createAnalyticsContext(c.get("db"), timeZone);
  const overview = await getAnalyticsOverview(ctx, { range, comparison: "none", granularity });
  const startOf = (dateKey: string) => new Date(commerceDayStart(timeZone, dateKey) * 1000).toISOString();
  const endOf = (dateKey: string) => startOf(shiftCommerceCalendarDateKey(dateKey, 1));
  return ok(c, {
    summary: {
      currency: overview.currency.code,
      timeZone,
      from: startOf(range.from),
      to: endOf(range.to),
      granularity,
      totals: figures(overview.current.totals),
      otherCurrencyOrders: overview.current.otherCurrencyOrders,
      buckets: overview.series.map((bucket) => ({
        from: startOf(bucket.from),
        to: endOf(bucket.to),
        ...figures(bucket.current),
      })),
    },
  });
});

export { app as adminResourceSettingsRoutes };
