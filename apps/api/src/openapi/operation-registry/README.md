# Operation registry and the stable app API

One registry row per `/api/v1` operation (`entry.ts` has the row shape and its
defaults). `openapi-contract.ts` turns each row into `x-scalius-agent`
metadata; the plugin dispatch, the MCP server and the CLI read that metadata.

## Tiers

`x-scalius-agent.stability` puts every operation in one tier:

- **stable**: the frozen app API (v2.0). A third-party app calls only these
  through `ctx.api.call`. `stable-operations.snapshot.json` records their
  request and response schemas and `stable-operations.test.ts` accepts only
  additive changes. A breaking change is a new operation.
- **beta**: may change in any release. Bundled first-party apps may call it;
  agents can call it, labelled Beta. The dashboard's own projections and
  editor flows live here, and so does every `storefront.*` operation: v2.0
  locks the app API only, and the headless storefront contract stabilises in
  a later 2.x.
- **internal**: no app ever calls it (staff, team, agent access, security,
  the store's webhook endpoints and app management).

## What the stable tier is

Resource-shaped, not dashboard-shaped. A stable operation reads or changes one
resource (orders, products, variants and inventory, customers, fulfilments and
shipments, discounts, catalog content, custom fields and Objects); it does not
mirror a dashboard screen, an editor section or a summary card.

- **Reads return the sealed representation.** `dashboard.resources.<type>.get`
  and `.list` (`/api/v1/admin/resources/...`) return exactly
  `EVENT_REPRESENTATION_SCHEMAS[type]` (`@scalius/shared/events`), the shape a
  webhook delivery carries in `data` under `EVENTS_API_VERSION`. A webhook
  receiver and an API reader see one representation, and a truncated
  delivery's `fetch` names the matching `get`. Lists page by cursor in
  `updatedAt, id` order (`updatedSince` starts a sync) and stop early before a
  page would pass the response budget.
- **Apps place orders for customers.** `dashboard.resources.orders.create`
  places a confirmed order the way staff do (stock reserved, tax and app
  discounts priced, app attributes checked) for a `customerId`, whose contact
  becomes the order's, so the app needs no contact scope. Lines may carry a
  `unitPriceMinor` set by hand (recorded on the timeline as `prices_set`),
  addresses use the canonical fields (Bangladesh may add its place ids), and
  an app's order is `channel: "app"`. The dashboard's own form stays
  `dashboard.orders.create` (beta). Payment is cash on delivery or an
  invoice paid later (`paymentMethod: "net_terms"`, `paymentTerms: { kind:
  "net", days }`); money received against an invoice is recorded with
  `dashboard.resources.payments.create` (Idempotency-Key required), and
  `dashboard.resources.orders.list?overdue=true` lists overdue invoices.
- **Apps sync products, issue gift cards and keep their own webhooks.**
  `dashboard.resources.products.create` makes a product with its options and
  SKUs (prices in minor units, stock at 0: quantities move through
  `variants.bulk_set_stock` under `write_inventory`); `products.update`
  patches its fields under `expectedRevision` in one write. Gift cards
  (`gift_cards.*`, `read_gift_cards` / the Sensitive `write_gift_cards`)
  issue, adjust under `expectedVersion` and disable; the code never reaches
  an app (`notify` has the store send it). `webhook_subscriptions.*`
  (`write_webhooks`, Sensitive) reach only the calling app's own
  subscriptions (`webhook_subscriptions.plugin_id`), on its approved hosts,
  for the topics and customer data its grant covers; every delivery re-checks
  the live grant, an inactive app's endpoints get nothing, uninstall deletes
  them, and the signing secret is returned once and never replayed for an
  Idempotency-Key repeat. The store's own endpoints stay staff-only
  (`dashboard.webhooks.*`, internal).
- **Money is integer minor units beside its currency**, the same rule as the
  webhook representations: `*Minor` integer fields, and an ISO 4217
  `currency` on the same object or the resource that holds it. Inputs take
  minor units only, in the resource's currency (the store currency for
  catalog prices, the order's for order amounts). No stable operation carries
  a decimal major-unit amount, in or out (`docs/ARCHITECTURE.md`, Money on the
  wire). The test fails on a decimal money field or a `*Minor` field with no
  currency in reach.
- **An instant is one ISO 8601 `date-time` string** (`2026-10-21T09:30:00.000Z`,
  UTC), in or out, as in the webhook representations: no epoch seconds or
  milliseconds, no bare string, no union of forms. Discount schedules are
  `startsAt`/`endsAt`. The test fails on any `*At`/`*Since` field of another
  form (`isoTimestampSchema` in `schemas/timestamps.ts`).
- **Regional and editor fields stay out.** `emiEligible`, product-level
  `freeDelivery` and product-level discount fields belong to the dashboard's
  editor routes (beta); no stable schema carries them.
- **One retry key.** Every stable mutation accepts exactly one key: the
  `Idempotency-Key` header, 8 to 200 printable characters (`ctx.api.call`'s
  `idempotencyKey` is sent as it). A repeat with the same key, by the same
  caller, for the same operation within 24 hours returns the first response
  (`Idempotent-Replayed: true`); the same key with a different request is
  refused with 422 `idempotency_key_reused`, and while the first is still
  running with 409 `idempotency_in_progress`. The replay rows live in
  `system_kv` (`routes/admin/idempotency.ts`); a 5xx is not stored, so a retry
  runs again. No stable request body carries a key: an operation with a
  durable retry key of its own (the stock ledger, fulfilments, timeline
  notes) derives it from the header. Stock moves require the header.
- **Writes take a precondition.** Every stable write that is not a create
  takes the revision it was based on (`expectedRevision`, `expectedVersion`,
  `expectedAggregateRevision` or `expectedStockVersion`, required or
  optional); a stale value is refused with 409 and changes nothing. Reads
  return them (`version` on orders, `stockVersion` on SKUs, `revision`
  elsewhere). The few writes with no revision to compare yet (custom field
  values, customers, the place import, publications) are listed in
  `stable-operations.test.ts`; an optional precondition added later is
  additive.
- **Contact data is gated twice.** Protected fields read null without their
  `read_customer_*` scope (COMMERCE-HOOKS H5), and an app may not search or
  filter by what it may not read: an email filter or search needs
  `read_customer_emails`, a phone one `read_customer_phones` and a name search
  `read_customer_names`, refused with 403 `contact_scope_required` otherwise.

## Agents

MCP `scalius_search` and `scalius_describe` (the CLI's `scalius search` and
`scalius describe`) show each operation's tier. Default CLI listings rank stable operations first; beta
operations stay callable and are labelled. The MCP server's instructions and
the OpenAPI document (`info.x-scalius-stability`) say the storefront surface is
beta.

Routing and gating fields (`x-scalius-agent`, every manifest entry):

- `when`: one "Use when ..." line (at most 240 characters) per executable
  operation, kept in `when-dashboard-a.ts`, `when-dashboard-b.ts` and
  `when-storefront.ts` beside the rows. Write it in the merchant's words, not
  with a sample value from a test task; the contract test fails on a missing
  one or one naming an unknown operation. `scalius_search`
  (`workflows/resolver-core.ts` `createWorkflowSearch`) ranks with it and
  `scalius_describe` shows it; the resolver's own index leaves it out.
- `dryRun`: `native` (the route takes `dryRun: true` and writes nothing),
  `preview:<operationId>` (a reviewed read on the same surface) or `none`.
- `confirmation`: `required` for destructive and financial risk, and for any
  row that adds the gate (gift-card writes). Both agent lanes pass one gate
  at the admin boundary (`agent-access/confirm-gate.ts`): MCP settles it with
  the confirm token or a client dialog, direct REST with the
  `Scalius-Confirm-Token` header from a 428 `confirmation_required` answer.
- `grantScope`: `customer_conversations` (the inbox) or `review_moderation`.
  No preset grant reaches them; a Custom grant that selected their permissions
  does (`agent-access/grant-scopes.ts`, checked on both lanes).

## Bulk runs

`dashboard.resources.variants.bulk_set_prices`, `variants.bulk_set_stock`,
`customers.bulk_tag`, `products.bulk_set_status` and `products.bulk_publish`
(`routes/admin/resources-bulk.ts`) change up to 5,000 items by ids or a list
filter. `dryRun: true` plans every item (before/after of the first 50, totals)
and writes nothing. A run is one `bulk_runs` row (migration 0159): 250 items
or fewer finish in the request (200), more answer 202 with the run and finish
right after the response and on the minute cron; `bulk_runs.get` reads it.
Each chunk of 90 commits its writes with the run's cursor and chunk counter,
so a repeat never applies a chunk twice: prices update field by field (no
`aggregateRevision` churn; the product's derived price and buyer state move in
the same batch), stock writes one ledger-v2 stock command per chunk.

## Changing a stable operation

Add a field, a value or an optional input and accept it with
`vitest run -u apps/api/src/openapi/stable-operations.test.ts`. Anything else
(remove, rename, retype, narrow, require) is a new operation. Promoting a beta
operation is additive; demoting a stable one is breaking.
