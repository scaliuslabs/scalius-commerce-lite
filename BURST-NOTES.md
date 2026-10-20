# Burst notes: event topic names (contract item 11) and line facts

Branch `worktree-agent-af8fb9a639fba60e5`, base `claude/commerce-hooks-plugins-builder` (5a2b7a6a5).

## Done

Commit `f7f6b23a8`: renamed the four topics. Each prefix now names its resource.

| Old | New | Resource |
| --- | --- | --- |
| `inventory.level_changed` | `variant.inventory_changed` | `variant` |
| `inventory.purchase_order_updated` | `purchase_order.updated` | `purchase_order` |
| `inventory.transfer_updated` | `inventory_transfer.updated` | `inventory_transfer` |
| `gift_card.transaction` (`transaction`) | `gift_card_transaction.created` | `gift_card_transaction` |

- Catalog (`packages/shared/src/events.ts`):
  - Topic prefixes: removed `inventory`, added `variant`, `purchase_order`, `inventory_transfer` and
    `gift_card_transaction`.
  - Representation key `transaction` is now `gift_card_transaction`
    (`giftCardTransactionRepresentationSchema`).
- Generator (`packages/database/scripts/event-outbox-triggers.ts`):
  - `EVENT_TOPIC_RENAME_MIGRATION = "0164_event_topic_names"`.
  - `EVENT_TOPICS_BEFORE_0164` keeps the old name and resource of each renamed topic.
  - Historical forms (0103, 0109) and the 0155 demand-gated forms render with the old names as superseded
    specs, so the immutable migrations still match and the PostgreSQL upgrade path compiles the real form.
  - The nine renamed triggers are now installed by 0164.
- Migration `0164_event_topic_names` (D1 and PostgreSQL twin), 43 statements:
  - Drops and re-creates the nine triggers, verbatim from the generator.
  - Renames `topic` and `resource_type` in `event_outbox`, `webhook_event_deliveries` and
    `plugin_event_deliveries`.
  - Rewrites quoted topic tokens in `webhook_subscriptions.topics` and in
    `plugin_installations.manifest_json`, `grant_json` and `grant_key`.
    - `"inventory.*"` becomes the three new prefixes.
    - `"gift_card.*"` also gains `"gift_card_transaction.*"`, so no subscriber loses an event.
  - Renames and expands `plugin_registrations` event rows.
  - Recomputes `event_demand`.
  - No CASE anywhere; the trigger bodies are one statement each.
- Metadata: journal idx 164, `schema-contract.ts` (current = 164, plus the sha), `schema-upgrade.test.ts`, and
  0164 added to the manual-snapshot allowlist (no table change).
- Updated: dashboard webhook i18n (en and bn, new group labels), realtime publish, the representation
  resolver, the admin resources doc string, the inventory README and the tests.

## Verified

The gates were run with the migration temporarily renumbered to 0163, because the provider-neutral chain must be
contiguous and 0163 belongs to another branch. The renumbering was reversed before the commit.

- `node packages/database/scripts/check-migration-metadata.mjs`: OK (renumbered).
- vitest, all green:
  - `packages/shared/src/events.test.ts`
  - `event-catalog-beta`, `event-demand`
  - `purchasing.d1`
  - `apps/api` `events/representations`, `realtime/publish`, `routes/admin/webhooks`
  - the non-Turso parts of `event-outbox` and `schema-upgrade`, including "carries its generated triggers
    verbatim" for 0103, 0108, 0109, 0113, 0119, 0122, 0155 and 0164.

## Unverified / left (exact next steps)

1. **Contiguity:** at 0164 with no 0163, `check:migrations` and `schema-upgrade.test.ts` fail ("not
   contiguous at 163"). The lead renumbers. My renumber script touched these spots:
   - the file names and the ledger `VALUES (164, '0164_…'` in both SQL files
   - journal `idx`/`tag`
   - `schema-contract.ts` (two places)
   - `schema-upgrade.test.ts` (two places)
   - `EVENT_TOPIC_RENAME_MIGRATION`
   - the allowlist entry

   The source sha does not change, because it excludes the ledger line.
2. **Turso-engine tests timed out** under host load (120 s limit): the 0103, 0109 and schema-upgrade Turso
   cases. They were not seen to pass with 0164. Re-run
   `pnpm exec vitest run packages/database/__tests__/schema-upgrade.test.ts packages/database/__tests__/event-outbox.test.ts`.
   Watch the `INSERT … SELECT … ON CONFLICT DO NOTHING` into `plugin_registrations` and the long nested
   `replace()` updates on the Turso engine.
3. **Not run:**
   - The ABI snapshot test (`packages/shared/src/plugins/abi.snapshot.test.ts`). `abi.protocol.snapshot.json`
     still has the old topics; this base has no `abi.breaks.json` (the checker is on `burst/shared-3`).
     Re-seal with `-u` and acknowledge the topic, resource and prefix breaks when the checker lands.
   - `pnpm generate:sdk`. The generated `openapi.json`, `types.gen.ts`, `sdk.gen.ts`,
     `openapi-contract.gen.txt`, `agent-operations.gen.txt` and `stable-operations.snapshot.json` still list
     the old topics.
   - PostgreSQL tests (`event-outbox-postgres.test.ts` was edited to the new names but not run).
   - DVC, typecheck and source-policies.
4. **No data-rewrite test yet:** add one that seeds old names into every stored place on a
   pre-0164 store (`createMigratedSqlite({ beforeMigration: "0164_" })`), applies 0164, and asserts the new
   names and the rebuilt `event_demand`.
5. **Docs:** `docs/platform/COMMERCE-HOOKS.md:120` (in the main checkout, untracked) still says
   `inventory.level_changed`.
6. **`grant_key`:** it is rewritten by the same token replace, so its event list may no longer be in sorted
   order. It stays a consistent CAS token, but it is not `pluginGrantKey()` canonical until the next approval.
7. **`inventory-purchasing-postgres-sidecar.test.ts`:** it runs only to 0109, so it rightly keeps the old
   names.

## Item 2: line-level facts (not started, per the time box)

The design is ready; none of it is committed.

- **Fulfillments:**
  - `order_fulfillment_lines` rows are inserted after the `order_fulfillments` row, in the same batch
    (`buildFulfilmentInsertStatements`). An AFTER INSERT trigger on the fulfilment therefore sees no lines.
  - Plan: add an `order_lines` EventExpr that renders a sorted aggregate over the line table joined to
    `order_items.variant_id`:
    - SQLite: `json((SELECT json_group_array(json_object(...)) FROM (… ORDER BY order_item_id)))`.
    - PostgreSQL: `coalesce(jsonb_agg(… ORDER BY …), '[]'::jsonb)`.
  - Put `lines` in the facts of `order.fulfilled`, `fulfillment.created` and `fulfillment.voided`.
  - Add one generated amendment trigger, `evt_order_fulfillment_lines_facts`: AFTER INSERT ON
    `order_fulfillment_lines`, demand-gated, with one `UPDATE event_outbox SET data = json_set(data,
    '$.lines', <aggregate>)` on the pending `fulfillment.created` row (resource = fulfilment) and the
    pending `order.fulfilled` row (resource = order, `$.fulfillmentId` matches).
  - Backfill `lines` on existing rows of those topics in the same migration, then make the fact required.
- **Refunds:** no truthful line facts are possible today.
  - `RefundRequest`, `refund_attempts` and refund `order_payments` rows are amount-only and record no order
    lines.
  - `order.refunded` needs a refund-lines ledger (`order_refund_lines`) and line input on the refund command
    first. That is a payment-path and HTTP-contract change for the lead to decide; a fact with no source
    would be fabricated.
