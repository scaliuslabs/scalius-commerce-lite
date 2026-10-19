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
  webhooks and app management).

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
  `updatedAt, id` order (`updatedAfter` starts a sync) and stop early before a
  page would pass the response budget.
- **Money is integer minor units beside its currency**, the same rule as the
  webhook representations: `*Minor` integer fields, and an ISO 4217
  `currency` on the same object or the resource that holds it. Inputs take
  minor units only, in the resource's currency (the store currency for
  catalog prices, the order's for order amounts). No stable operation carries
  a decimal major-unit amount, in or out (`docs/ARCHITECTURE.md`, Money on the
  wire). The test fails on a decimal money field or a `*Minor` field with no
  currency in reach.
- **Regional and editor fields stay out.** `emiEligible`, product-level
  `freeDelivery` and product-level discount fields belong to the dashboard's
  editor routes (beta); no stable schema carries them.
- **Creates are idempotent.** Every stable create accepts an optional
  `Idempotency-Key` header (8 to 200 characters). A repeat with the same key,
  by the same caller, for the same operation within 24 hours returns the
  first response (`Idempotent-Replayed: true`); the same key with a different
  request is refused with 422 `idempotency_key_reused`, and while the first is
  still running with 409 `idempotency_in_progress`. The replay rows live in
  `api_idempotency_keys` (`idempotency.ts` beside the admin routes); a 5xx is
  not stored, so a retry runs again. An operation with its own durable retry
  key (stock adjustments, fulfilments, pickup) keeps it and maps the header
  onto it.
- **Updates take a precondition.** An update to a resource with a revision
  column takes it (`expectedRevision`, `expectedVersion` or
  `expectedAggregateRevision`); a stale value is refused with 409 and changes
  nothing.
- **Contact data is gated twice.** Protected fields read null without their
  `read_customer_*` scope (COMMERCE-HOOKS H5), and an app may not search or
  filter by what it may not read: an email filter or search needs
  `read_customer_emails`, a phone one `read_customer_phones` and a name search
  `read_customer_names`, refused with 403 `contact_scope_required` otherwise.

## Agents

MCP `operations.describe` and the CLI's `operations search` show each
operation's tier. Default CLI listings rank stable operations first; beta
operations stay callable and are labelled. The MCP server's instructions and
the OpenAPI document (`info.x-scalius-stability`) say the storefront surface is
beta.

## Changing a stable operation

Add a field, a value or an optional input and accept it with
`vitest run -u apps/api/src/openapi/stable-operations.test.ts`. Anything else
(remove, rename, retype, narrow, require) is a new operation. Promoting a beta
operation is additive; demoting a stable one is breaking.
