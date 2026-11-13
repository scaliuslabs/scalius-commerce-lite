# Store setup, time zone, units and formatting

The store-wide facts set on a new store, and the rules that keep every surface consistent with them.
Code: `packages/core/src/modules/onboarding` (setup), `packages/core/src/modules/platform/store-defaults.service.ts`,
`@scalius/shared/commerce-time` and `@scalius/shared/locale-format`.

## Store setup

After the first admin, `/admin/welcome` asks for store name, country, currency, language, time zone and
units (Shopify's "Tell us about your store"), with defaults from the country's CLDR data.
`POST /api/v1/admin/settings/store-setup` writes them in one guarded batch: the business document, the
backup market (name, country, language, price increment), the currency and the time zone and units. The
guard accepts only a new store (no order, one market, the backup market still at revision 1), so setup
runs at most once (409 `store_setup_done`); products or delivery methods lock the currency. Setup creates
no tax region and no shipping zone. Headless installs send the same fields as `store` in
`POST /api/v1/setup`. Everything stays editable in Settings.

## Store time zone

An IANA zone, the merchant calendar: report buckets, date filters, exports, invoices, cron schedules, the
nightly pass (02:00 store time) and every displayed date. It lives in the `platform` document beside the
units, so Worker entry already has it (no extra read). A missing value reads as `Asia/Dhaka`, metric,
grams, so older stores behave as before.

- Calendar math uses `Intl` for the zone; a day can be 23, 24 or 25 hours; no code uses a fixed offset.
- SQL buckets (`merchantDaySql`) write each offset change in the range as integer literals in a `CASE`,
  so the statement binds nothing more and runs the same on D1, Turso and PostgreSQL.
- Changing the zone keeps order instants; reports regroup them.

## Units

Weights are stored in grams. The unit system and weight unit change only how the dashboard shows and
accepts them. Courier settings keep the courier's own unit, because the courier's API defines it.

## Formatting and the week

`@scalius/shared/locale-format` is the one formatting layer; `scripts/check-source-policies.mjs` rejects
an `Intl` formatter or `toLocaleString` elsewhere. Locales come from the reader's language and the store
country (the backup market's). English in Bangladesh writes numbers as `en-IN` (lakhs), because CLDR has
no English for Bangladesh, and dates as `en-BD`; Bangla uses Bangla digits and a 24-hour clock (Intl has
no Bangla AM/PM). The first day of the week is CLDR's for the country, in date pickers and in SQL week
buckets. Right-to-left languages set `dir="rtl"`.
