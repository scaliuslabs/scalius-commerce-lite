# Store setup, time zone and units

This document describes three store-wide facts and the step that sets them on a new store:

- the **store setup** step after the first admin;
- the **store time zone** (the merchant calendar);
- the **unit system** and the default weight unit.

They copy Shopify: "Tell us about your store" during sign-up, and the Store defaults card in Settings → Store details.

## Store setup

After the first admin signs in, the dashboard opens `/admin/welcome`. The page asks for:

| Field | Default |
| --- | --- |
| Store name | The business name, if one exists |
| Country/region | The backup market's country (BD on a fresh install) |
| Currency | The country's currency (CLDR `currencyData`); USD when Scalius does not sell in it |
| Store language | The root presence's language |
| Time zone | The browser's time zone |
| Unit system and weight unit | The country's system (CLDR `measurementData`: imperial for US and LR), then the system's default unit (kg, lb) |

`POST /api/v1/admin/settings/store-setup` (`dashboard.settings.store_setup_apply`) writes everything in one guarded batch (`packages/core/src/modules/onboarding`):

1. the business name and the country name (business document);
2. the backup market: its name and handle (the country's English name), its one country, the root presence's language, and the currency's default price increment (`markets.backupMarketSetupWrites`);
3. the shop currency and its symbol (currency document), only when the currency changes;
4. the time zone and units (platform document).

The batch guard refuses a store that is no longer new. A store is new while it has no order, it has one market, and the backup market still has revision 1 (as migration 0112 created it). Then the API answers 409 `STORE_SETUP_DONE` and writes nothing. A second request for the same store therefore gets 409, so the step runs at most once. Products or delivery methods lock the currency: setup keeps the current currency or refuses a different one.

Setup creates no tax region and no shipping zone. The Home setup guide shows "Tell us about your store" while the store is new, then "Review delivery charges" and "Review taxes".

When the price increment changes (whole taka to cents), the API queues the catalogue projection rebuild.

Headless installs send the same fields as `store` in `POST /api/v1/setup`. The admin is created first; a refused setup reports `storeSetup: "skipped"` and the dashboard step stays available. `pnpm dev:admin:create --country <code> [--time-zone <zone>] [--currency <code>] [--store-name <name>]` uses it. The default country is BD with Asia/Dhaka.

Everything stays editable: Settings → Store details (name, currency, time zone, units) and Settings → Markets (countries, language, price increment).

## Store time zone

The store time zone is an IANA name, such as `America/New_York`. It is the merchant calendar. These use it:

- analytics day, week and month buckets, ranges and comparisons;
- the Home summary (this month, last month) and the daily activity;
- order and inventory date filters, order CSV dates and export file names;
- customer segment calendar-date filters;
- invoice dates, gift-card expiry text and warranty claim dates;
- plugin cron schedules and the nightly catalogue pass (02:00 store time);
- the default schedule zone of a new discount;
- every date in the dashboard, and buyer-facing dates on the storefront (orders, reviews, blog posts, messages).

**Storage.** The zone, the unit system and the weight unit are fields of the `platform` settings document (`timeZone`, `unitSystem`, `weightUnit`). Worker entry resolves that document from its KV mirror for every request, cron run and queue batch (`env.PLATFORM_CONFIG`). Thus no request spends a database read on them. A missing or unknown value reads as `Asia/Dhaka`, metric, grams: every store from before this setting behaves as before.

**Calendar math.** `@scalius/shared/commerce-time` computes every boundary with `Intl` for the zone. A day can be 23, 24 or 25 hours long. A day that skips midnight starts at the first instant after the gap. No code uses a fixed offset.

**SQL buckets.** `merchantDaySql(column, offsets)` maps an instant to its merchant day as `cast((column + offset) / 86400 as integer)`. The offset is the zone's offset at that instant. `zoneOffsetSchedule` finds each offset change in the range to the second, and the SQL writes them as integer literals in a `CASE`. A zone without daylight saving has one offset, so an Asia/Dhaka store runs the same arithmetic as before (`+ 21600`). The statement binds nothing more, needs no `json_each` join and runs the same on D1, TursoDB and PostgreSQL. A value that can lie outside the range (a customer's first order) is read as an instant and dated in JavaScript.

**Reads.** Analytics and Home reads take the zone from `env.PLATFORM_CONFIG` (`storeTimeZoneOf`). Deep reads inside checkout pricing (a segment's date filter) and warranty texts read the request's zone from `@scalius/core/utils/store-time-zone`, which the API sets beside the public media URL. D1 calls and statements did not change.

**Cache.** A public render reads the platform row through its tracked path (`withTrackedPlatformEnv`), which declares `set:platform:document`. The storefront layout part carries `timeZone`, so a saved zone advances every page that formats a date. Layout.astro writes `data-store-time-zone` on `<html>` for browser code, only when the zone is not the default.

**Dashboard.** `lib/store-time-zone.ts` holds the zone for the tab. The admin frame's loader reads the store defaults (`dashboard.settings.store_defaults_get`, any staff) and sets it. The last value is kept in `localStorage`, so the next visit formats correctly at once. `useMessages` re-renders when the zone changes.

**Changing the zone.** Orders keep their instants. Reports regroup them by the new zone's days.

## Units

Weights are stored in grams (`product_variants.weight`). The unit system and the default weight unit change only how the dashboard shows and accepts them: the product form's weight field converts at the field (`WeightInput`). The metric system offers kg and g; the imperial system offers lb and oz. A new system without a unit takes the system's default unit. Courier settings keep the courier's own unit (kg), because the courier's API defines it. Rates by weight are a later item.

## Operations

| Operation | Permission | Notes |
| --- | --- | --- |
| `dashboard.settings.store_defaults_get` | any staff | time zone, unit system, weight unit, platform revision |
| `dashboard.settings.store_defaults_update` | Edit store settings | revision required; writes the KV mirror |
| `dashboard.settings.store_setup_get` | View store settings | `needed`, `done`, current values, `currencyLocked` |
| `dashboard.settings.store_setup_apply` | Edit store settings | 409 `STORE_SETUP_DONE` once the store is not new |

The agent routes `dashboard.store-defaults` and `dashboard.store-setup` plan these operations. The control `dashboard.timezone-separate-review` keeps a time zone change out of the Bangladesh checkout setup. The analytics overview response carries `timeZone`.
