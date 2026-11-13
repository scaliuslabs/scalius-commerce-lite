# Operation registry and the stable app API

One registry row per `/api/v1` operation (`entry.ts` has the row shape and its
defaults). `openapi-contract.ts` turns each row into `x-scalius-agent`
metadata; the plugin dispatch, the MCP server and the CLI read that metadata.

## Tiers

`x-scalius-agent.stability` puts every operation in one tier:

- **stable**: the frozen app API (v2.0), exactly the operations the sealed
  app-name table `STABLE_APP_OPERATIONS` lists. A third-party app calls only
  these through `ctx.api.call`. `stable-operations.snapshot.json` records their
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

Resource-shaped, not dashboard-shaped: a stable operation reads or changes one resource (orders,
products, variants and inventory, customers, fulfilments, discounts, content, custom fields, Objects); it
does not mirror a screen. What each operation does is in its schema and handler; the snapshot is the list.
The rules every stable operation keeps (`stable-operations.test.ts` checks them):

- **Reads return the sealed representation** (`EVENT_REPRESENTATION_SCHEMAS`), the shape a webhook
  carries, so a webhook receiver and an API reader see one thing; a truncated delivery's `fetch` names the
  stable read that answers it. Lists page by cursor in `updatedAt, id` order (`updatedSince` starts a
  sync). Order, payment, refund, return, shipment and fulfilment states are sealed enums
  (`@scalius/shared/resource-states`).
- **Money is integer minor units beside its currency**; no decimal major-unit amount.
- **An instant is one ISO 8601 date-time string.**
- **Apps name an operation by resource and verb**, from one sealed table (`STABLE_APP_OPERATIONS`).
- **A write refuses a field it does not declare** (400 `validation_error`, one `unrecognized_keys`
  issue per key), so a caller never reads 200 for a field that was not saved.
- **One lane per owner**: operations reach the merchant's data; an app's own data goes through `ctx`.
- **Error codes are one lower_snake vocabulary** (`error-vocabulary.test.ts`); what an app can branch on
  is sealed in `APP_ERROR_CODES` (`@scalius/shared/plugins/app-errors`, part of the ABI snapshot).
- **Lists page one way**: `cursor` + `limit` in, `{ <plural>, nextCursor }` out.
- **One answer shape per kind**: `{ <singular>: Resource }`; a permanent delete answers
  `{ id, deleted: true }`.
- **One address shape**: the representation's `PostalAddress`, with Bangladesh place ids only under
  `placeIds`.
- **Regional and editor fields stay out** of stable schemas.
- **One retry key**: the `Idempotency-Key` header (24 hours; a different request is 422, a running one
  409; a 5xx is not stored). No request body carries a key.
- **A lost response is recovered, never acted twice**: after the 120-second lease a repeat re-runs only
  an operation that cannot act twice; a create without a durable key answers 409
  `idempotency_outcome_unknown` (`retryAfterLostResponse` in `routes/admin/idempotency.ts`).
- **Writes take a precondition**: `expectedRevision` (or `expectedStockVersion` for stock); stale is 409.
  The writes with nothing to compare yet are listed in the test.
- **Contact data is gated twice**: protected fields read null without their `read_customer_*` scope, and
  an app may not search or filter by what it may not read (403 `contact_scope_required`).

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
  the owner's dashboard approval or a client dialog, direct REST with the
  `Scalius-Approval` header naming the approval its owner gave at the
  `approvalUrl` of a 428 `confirmation_required` answer. A REST approval
  binds the exact request: its query string, Content-Type and body bytes,
  so the retry must repeat them byte for byte. A native dry run on that lane
  is read where the route reads it (the body's `dryRun`; the query only for
  a bodyless method).
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
