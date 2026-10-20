# Burst notes: one money wire format for objects and custom fields

Object `money` / `list.money` fields and custom-field money values now cross every app boundary as
`{ amountMinor, currency }` (store currency; integer minor units). Money validation bounds are integer
minor units. Storage is unchanged (minor units), so there is no migration.

## Verified (targeted vitest under scalius-lock)

- `packages/shared/src/custom-fields.test.ts`, `packages/shared/src/plugins/objects.test.ts`
- `packages/shared/src/plugins/abi.snapshot.test.ts` (SDK snapshot updated with `-u`)
- `packages/plugin-sdk/src/testing.test.ts` (new money test: ctx.objects, ctx.customFields, where, update round trip)
- `packages/core/src/modules/custom-fields/custom-fields.d1.test.ts`, `packages/core/src/modules/checkout/app-reads.d1.test.ts`,
  `packages/core/src/modules/objects/storefront.test.ts`, `packages/core/src/modules/catalog/**`
- `apps/api/src/routes/admin/custom-fields.d1.test.ts`, `objects.d1.test.ts`, `app-list-columns.d1.test.ts`,
  `apps/api/src/cache-deps-custom-fields.test.ts`
- Dashboard: `custom-field-draft.test.ts`, `CustomFieldInput.test.tsx`, `CustomFieldsCard.test.tsx`,
  `object-entry-form.test.ts`, `objects.test.tsx`, `custom-data-settings.test.tsx`
- `node scripts/check-source-policies.mjs`
- One package-level typecheck: see the final line of this file.

## Unverified / left for the lead

- **`pnpm generate:sdk` not run.** OpenAPI descriptions changed (custom-field value and validation bounds,
  `ObjectRecord.data`, `objects.list` where). `packages/api-client/openapi.json`, `apps/api/src/generated/*` and
  `apps/api/src/openapi/stable-operations.snapshot.json` are stale until regenerated; then run
  `apps/api/src/openapi/stable-operations.test.ts`.
- **Dashboard typecheck not run** (`apps/admin-v2`): `valueFromDraft`, `createEntryBody`, `updateEntryBody` gained a
  codec-context parameter; all callers found by grep were updated. Also `pnpm --filter ./apps/admin-v2 lint`.
- Full suites, DVC gate, workspace typecheck: not run (burst rules).
- Harness `ctx.customFields.set` refuses an invalid value with `custom_fields.invalid`; parity of that code with the
  real bridge error mapping (ValidationError through `guard`) is not checked.
- **Stored object-type validations:** object type `fieldsJson` keeps validations as declared (wire form). A money
  field declared earlier with a major-unit bound (`min: 5`) now reads as 5 minor units. Pre-lock with no known
  stores using money bounds on objects; custom-field definitions store canonical minor bounds and are unaffected.

## Deliberately unchanged

- **Storefront contract** keeps major units: `customFieldStorefrontValue` / `objectDataStorefront` feed
  `custom-fields.storefront.ts`, `objects/storefront.ts` (sections, bindings, public `/api/v1/objects`) and
  `catalog/card-fields.ts`. For the storefront-protocol owner: `storefront-protocol.ts` line ~293 ("money in major
  units") stays true. If storefront `fields` should carry `{ amountMinor, currency }` or `StorefrontMoney`, change
  those two projection functions only.
- Dashboard list columns (`apps/api/src/plugins/list-columns.ts`, `appValues`/`appFilter`): dashboard-tier, still
  major units, read straight from storage.
- Checkout/payments/orders, `CartFlyout`, `manifest.ts`: untouched.

## Follow-ups worth a decision

- App UI table cells use `{ money: <minor>, currency? }` (`packages/shared/src/plugins/ui.ts`): minor units already,
  but a different key from `{ amountMinor, currency }`. Accepting `PluginMoney` there would let apps pass a record's
  money straight to a table.
- `AGENT_MCP_INSTRUCTIONS` (`apps/api/src/agent-access/mcp/server.ts`) says "money is decimal major units"; stable
  resource reads and now custom-field/object values are minor. Wording belongs to the MCP owner (< 500 bytes test).
- `increment` cannot add to a money field (the runtime does not know field types); README says to `update` it.

Typecheck: `tsc --build apps/api` (shared, database, core, plugin-sdk, api) exits 0. `apps/admin-v2` not typechecked.
