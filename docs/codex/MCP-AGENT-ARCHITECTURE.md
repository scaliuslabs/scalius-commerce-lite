# MCP And Agent Architecture

Last reviewed: 2026-07-08

This is the release-safe target for Scalius MCP and assistant work. It replaces `mcp.md` as durable repo guidance; `mcp.md` is intentionally local scratch and must not be committed.

## Decision

Build one tracked Cloudflare workspace, `apps/agent`, for durable assistants and MCP endpoints. Keep the commerce API as the domain authority.

- `apps/agent` owns Flue durable agent sessions, model orchestration, MCP protocol routes, and assistant event streams.
- Stateless public catalog MCP may use Cloudflare's `createMcpHandler` directly before Flue state is needed.
- `apps/api` remains the only authority for admin auth, RBAC, checkout, orders, payments, inventory, settings, feeds, SEO policy, and provider credentials.
- `apps/admin-v2` owns visible admin page state: current route, dirty forms, selected rows, dialogs, validation errors, and navigation.
- `apps/storefront` owns buyer-visible page context, local cart snapshot reads, same-origin cart validation, and navigation.

Do not import database or core domain modules into the agent Worker unless an architecture review proves the service-binding API path cannot satisfy the use case. The boring default is: agent asks the API, API enforces the rules.

## First Release Scope

### Admin MCP

Admin MCP is authenticated, admin-only, and starts small.

- Use the active dashboard/admin session and API service binding. Do not add bearer/JWT fallback.
- Enforce Better Auth session validity, onboarding gates, 2FA truth, and API RBAC through existing admin API middleware.
- The first implemented admin slice is intentionally tiny: `apps/agent` accepts `/mcp/admin` only on the internal service-binding host `http://agent.internal/mcp/admin`, `apps/admin-v2` proxies it from `/api/assistant/mcp`, and the first tools are read-only context/search/settings helpers: `admin_session_context`, `admin_navigation_context`, `admin_dashboard_summary`, `admin_settings_summary`, `admin_notification_settings_summary`, `admin_analytics_summary`, `admin_category_search`, `admin_collection_search`, `admin_page_search`, `admin_media_search`, `admin_product_search`, `admin_order_search`, `admin_customer_search`, and `admin_inventory_lookup`.
- That first admin slice forwards only the dashboard cookie and MCP protocol headers, strips `Authorization`, checks `/api/v1/admin/rbac/my-permissions` through the API service binding, returns `Cache-Control: no-store`, and has no direct D1/KV/R2/queue/provider-secret bindings. `admin_navigation_context` returns a bounded static dashboard entry-page catalog filtered by effective API permissions; it does not navigate, mutate, expose dynamic routes, or import dashboard/core route guards into the agent Worker. `admin_dashboard_summary` calls only `GET /api/v1/admin/dashboard/metrics-summary`, a no-PII API route that returns `getDashboardSummaryStats(db)` only; it uses strict empty input and returns aggregate month/product/customer stats plus explicit privacy/mutation limits while omitting recent orders, order IDs, customer PII/contact data, lifetime revenue, daily activity, payment evidence, provider payloads, unknown upstream fields, upstream error bodies, and mutation authority. `admin_settings_summary` calls only `GET /api/v1/admin/settings/mcp-summary`, an API-owned redacted readiness projection guarded by `settings.general.view`; it uses strict empty input and returns booleans, counts, bounded checkout issues, sanitized absolute storefront URL, country/currency, checkout policy, payment method IDs/status, SEO discovery toggles, return-policy facts, provider readiness counts/status, and explicit redaction/mutation limits. It must never expose credential values, masked secrets, provider account identifiers, business contact fields, analytics snippets/custom code, raw logs, provider payloads, customer PII, receipt proofs, OTP/session/cookie material, or raw upstream error bodies. `admin_notification_settings_summary` calls only `GET /api/v1/admin/settings/notification-channels/mcp-summary`, guarded by `settings.general.view`; it returns customer channel support/readiness/event counts, merchant push support/readiness/event counts, WhatsApp template booleans, totals, and explicit privacy limits while omitting credential values, masked secrets, provider identifiers, raw provider errors, recipients, order IDs, delivery receipts, template names, language codes, unknown upstream fields, upstream error bodies, and mutation authority. `admin_analytics_summary` calls only `GET /api/v1/admin/analytics/health` through the API service binding with strict empty input, returns aggregate analytics readiness counts plus compact browser/server status/counts for each analytics type, and omits script config, snippets, custom code, raw issue strings, provider messages, account identifiers, credentials, provider payloads, unknown upstream fields, upstream error bodies, and mutation authority. `admin_category_search` calls only the existing admin categories API through the API service binding with bounded `{ query, page, limit }` and returns compact category identifiers plus discovery metadata while omitting descriptions, meta fields, images, deleted rows/fields, unknown upstream fields, and any create/update/delete authority. `admin_collection_search` calls only the existing admin collections API through the API service binding with bounded `{ query, page, limit }` and returns compact collection id/name/product-count/discovery metadata, including canonical paths only when they exactly match the current ID-routed `/collections/<collectionId>` path, while omitting slugs, descriptions, meta fields, images, product records/lists, deleted rows/fields, unknown upstream fields, and any create/update/delete authority. `admin_page_search` is API-service-binding-only: it calls only the existing admin CMS pages API with bounded `{ query, page, limit }` and returns compact CMS page identifiers plus publish, discovery, and layout flags; canonical paths are included only when they are valid non-reserved one-segment CMS page paths, and the tool omits HTML content, meta copy, images, deleted rows/fields, unknown upstream fields, and any mutation authority. `admin_media_search` is API-service-binding-only: it calls only the existing admin media listing/search API with bounded latest/search inputs such as `{ query, page, limit, folderId, mimeType }` filters and returns compact media file metadata only. Media URLs must be safe URLs, and the tool must omit upload/delete/move/folder mutation authority, storage internals, deleted or unknown fields, and upstream error bodies. `admin_product_search` calls only `GET /api/v1/admin/products` through the API service binding with bounded `{ query, page, limit }`, fixed `updatedAt desc` ordering, and a compact projection that omits descriptions, prices, discounts, SKUs, images, stock, barcodes, deleted fields, and unknown upstream fields. `admin_order_search` calls only the existing admin orders API through the API service binding with bounded `{ query, page, limit }` and returns compact order identifiers/status/timestamp summaries while omitting raw buyer PII, secrets, provider payloads, receipt/recovery/session tokens, items/item lines, addresses, tracking data, raw payment evidence, and unknown upstream fields; masked contact hints are passed through only when the upstream response already provides masked values. `admin_customer_search` calls only API-owned `POST /api/v1/admin/customers/mcp-search` with a strict JSON body so phone/email searches never enter URLs; it returns customer IDs, order/spend aggregates, timestamps, redacted request metadata, pagination, and explicit privacy limits while omitting the raw query, names, email, phone, addresses, locations, history, order lists, trashed rows, unknown upstream fields, upstream error bodies, and mutation authority. `admin_inventory_lookup` is API-service-binding-only over `GET /api/v1/admin/inventory` with fixed `section=variants` plus bounded `query`, `page`, `limit`, `status`, `sort`, and `order`; it returns compact tracked-variant stock fields and aggregate stats only, and excludes inventory movements, alerts, barcodes, prices, version fields, adjustment authority, scanner lookup, order IDs, notes, and upstream error bodies.
- The first page-state bridge is mounted in the admin shell at `apps/admin-v2/src/components/admin/assistant/**`. It publishes a sanitized browser-only snapshot under `window.__SCALIUS_ADMIN_ASSISTANT_PAGE_STATE__` and `scalius:admin-assistant-page-state`, limited to pathname, title, heading, scroll state, and explicitly registered visible surfaces.
- Admin page-state code must not query arbitrary form controls, read DOM field values, observe the entire admin content subtree, call APIs, or read cookies/storage. Forms/tables/dialogs must register safe aggregate state through `registerAdminAssistantSurface()` when page tools need them.
- The first MCP-powered admin chat bridge lives in the API, not the browser: `apps/api` uses the `AGENT` service binding, initializes `http://agent.internal/mcp/admin`, calls only `admin_navigation_context`, forwards only the dashboard cookie plus sanitized User-Agent, strips bearer auth, compacts the result to bounded entry-page destinations, and returns optional click-confirmed `navigate` actions. The model never receives credentials, raw MCP output, dynamic detail URLs, or mutation authority, and the dashboard sanitizes the action path again before TanStack navigation.
- Use Cloudflare Code Mode only for the large admin OpenAPI/search surface, with an allowlisted execute path and host-owned auth callback.
- Prefer typed high-value tools for risky or important workflows.
- Expose read/search tools first. Current verified tools cover dashboard summary, redacted settings and analytics readiness, products, categories, collections, CMS pages, orders, redacted customer search, media listing, and inventory lookup.
- Page tools may navigate, inspect page state, select rows, set fields, save a visible registered form, discard changes, or clear selection.

Excluded from the first release: RBAC writes, admin-user invites/deletes, permanent deletes, refunds, order status/payment/shipping transitions, provider credential writes, cache clear, feed/SEO bulk toggles, raw provider payloads, recovery bearer links, and any operation that can move money or stock without a human-visible confirmation model.

### Storefront MCP

Storefront MCP is public and catalog-first.

- Use typed tools over the existing UCP/feed/catalog projection, not Code Mode.
- The first implemented slice is `@scalius/agent` with `GET /health` and stateless `/mcp` read tools: catalog tools `catalog_search`, `catalog_lookup`, `catalog_product`, `catalog_profile`, and `catalog_categories`, `storefront_discovery_policy` for public discovery/return-policy facts, plus `cart_validate` for bounded read-only cart snapshot validation.
- That first slice has no D1, R2, KV, queue, Durable Object, provider-secret, admin, customer, order, checkout, payment, fulfillment, support, recovery, or cart-mutation bindings/tools.
- `catalog_categories` is public, read-only, API service-binding-only, and compact: it may expose category identifiers, labels, slugs/paths, hierarchy/count hints, and discovery metadata needed for catalog browsing, but it must not send cookies/auth headers or expose private customer, order, payment, checkout, receipt, recovery, support, session, provider, or admin data.
- `storefront_discovery_policy` is public, read-only, API service-binding-only, and compact: it calls only `GET /api/v1/seo`, sends no cookies/auth headers, returns sitemap/feed/robots/structured-data toggles, absolute storefront discovery URLs, and merchant-saved return-policy facts, and exposes explicit read-only/no-private-data limits. It must not expose raw robots text, checkout/payment/order/customer/session/cart data, analytics snippets, provider payloads, upstream error bodies, or mutation authority.
- The first page-context bridge is mounted in the storefront layout at `apps/storefront/src/components/assistant/**` and `apps/storefront/src/lib/assistant-page-context*`. It publishes a sanitized browser-only snapshot under `window.__SCALIUS_STOREFRONT_PAGE_CONTEXT__` and `scalius:storefront-page-context:change`, limited to public route/canonical/title/page kind plus a bounded allowlisted cart summary. It also exposes frozen `window.__SCALIUS_STOREFRONT_ASSISTANT__` helpers: `getContext()` returns the current sanitized snapshot and `navigate(target)` accepts only same-origin public buyer paths such as product/category/collection/search/cart/CMS pages while rejecting checkout, order, account, admin, API, payment, recovery, token-like, off-origin, traversal, and sensitive-query targets.
- Storefront page-context code must not call `hydrateCartFromStorage()`, read raw cookies/storage payloads, customer sessions, order/receipt proofs, phone/email/address/payment details, discount codes, or mutate cart/checkout state. Cart context is summary-only, passively read from the current cart store snapshot, until a signed D1-backed assistant session exists. Cart line options must use merchant-defined `{ name, label }` pairs from the product option labels; legacy `size`/`color` fields are fallback compatibility only.
- Expose catalog search, catalog lookup, product context, compact category reads, discovery policy reads, visible page context, same-origin navigation, and read-only cart snapshot validation.
- Cart validation may explain stale cart issues using existing `PRODUCT_UNAVAILABLE`, `VARIANT_UNAVAILABLE`, `VARIANT_MISMATCH`, `VARIANT_REQUIRED`, `QUANTITY_UNAVAILABLE`, and `PRICE_CHANGED` repair semantics.

Do not expose checkout, cart mutation, order, payment, fulfillment, customer-profile, hosted-payment recovery, or support-request tools until there is a D1-backed session, idempotency, signing, and payment-recovery design verified in code and live smokes.

## UI Direction

Use Flue for durable agent state and assistant workflows once the product needs sessions, task memory, or long-running flows. Do not add Flue state to the stateless public catalog MCP slice until a concrete workflow needs it. Use `@flue/react` or `@flue/sdk` for client state integration when durable UI workflows start.

For visible chat/task UI, adapt AI Elements-style composable components into the existing admin/storefront design systems instead of inventing a full chat UI from scratch. `assistant-ui` remains a good fallback for polished primitives, but first release should avoid a large opinionated UI platform. AG-UI/CopilotKit is too broad for v1 unless future work needs deep bidirectional agent state beyond what the page-state bridges provide.

The first visible Admin Assistant slice is intentionally smaller than full tool-use: the dashboard header opens a right-side chat sheet, sends bounded conversation history plus the existing sanitized page-state snapshot through an admin server function, and the API calls the configured `adminChat` model profile. It is stateless, no-store, and read-only. The only MCP-powered runtime context it may use today is the API-owned `admin_navigation_context` call that produces click-confirmed dashboard navigation actions. It still has no page tools, Code Mode, direct domain reads beyond that bounded destination catalog, or mutation authority.

## Durable Runtime Sequencing

2026-07-08 decision: do not add Flue or Cloudflare Code Mode to the two-day stable-release path yet. Current code already has the Cloudflare Agents SDK in use for the API widget design Durable Object and uses `agents/mcp` for the tracked `@scalius/agent` MCP Worker, but no active workspace package depends on `@flue/*` or `@cloudflare/codemode`.

Before adding Flue, record a focused ADR here for the durable assistant runtime: source-root ownership inside `apps/agent`, Durable Object migration history, how it relates to the existing API `WidgetDesignAgent`, exactly what Flue may persist, model-profile resolution through `settings.ai`, observability, reconnect semantics, and the verification/deploy gates. Before adding Code Mode, record a separate allowlist and authorization-boundary decision: API OpenAPI search/execute scope, host-owned auth callback, outbound-network policy, no storefront Code Mode, no hidden money/stock/provider-secret mutations, and human-confirmation rules for any operation that can change buyer or merchant state.

Until those ADRs exist and are verified, improve the existing bridge first: API-owned `AGENT` service binding, dashboard/storefront page-state bridges, typed read tools, click-confirmed visible navigation, and explicit no-mutation failure behavior.

References reviewed:

- [Cloudflare MCP overview](https://developers.cloudflare.com/agents/model-context-protocol/)
- [Cloudflare Streamable HTTP MCP transport](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/)
- [Cloudflare `createMcpHandler` API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [Cloudflare Code Mode MCP pattern](https://developers.cloudflare.com/agents/model-context-protocol/codemode/)
- [Flue Cloudflare deployment](https://flueframework.com/docs/ecosystem/deploy/cloudflare/)
- [AI Elements](https://elements.ai-sdk.dev/)
- [assistant-ui](https://www.assistant-ui.com/)
- [AG-UI](https://www.copilotkit.ai/ag-ui)

## Model And Credential Configuration

Reuse the existing `settings.ai` encrypted credential/config system. Do not create a second credential store for assistants.

Add assistant model profiles under the AI settings domain when implementation starts:

- `adminChat`
- `storefrontChat`
- `widgetGeneration`
- `imageGeneration`
- `voice`

Only `widgetGeneration` should inherit the current widget provider's default model. Assistant profiles such as `adminChat`, `storefrontChat`, `imageGeneration`, and `voice` default disabled with an empty model until a saved API profile explicitly configures them. `adminChat` has a visible stateless dashboard chat route, but it must still fail closed until the merchant enables that profile with a usable provider/model/credential.

Environment variables may provide safe defaults; dashboard settings may override them. Secrets stay encrypted with `CREDENTIAL_ENCRYPTION_KEY`. Hot send paths must fail closed when credentials are missing, dummy, or undecryptable. Existing widget AI settings already strict-read encrypted provider keys through `readStoredCredentialStrict()` and surface safe `credentialErrors`; keep future assistant profiles on that same path instead of adding permissive fallback reads.

## Required Guards

Before exposing any MCP endpoint publicly:

- Admin MCP must stay hidden from the public agent host. Direct public `/mcp/admin` requests must return a bland no-store 404 before cookie/API preflight; the dashboard `/api/assistant/mcp` proxy is the only external entry point, and it must prove no access without a signed Better Auth admin cookie, completed onboarding, verified 2FA, and matching RBAC permission.
- Admin page tools must use the same page-permission source as the dashboard route guard, or have a drift test that fails when maps diverge.
- Admin form tools must operate only on registered visible forms and must refuse hidden credential fields unless a dedicated, human-confirmed credential-flow design exists.
- Storefront UCP tests must prove only catalog read capabilities such as search, lookup, and product are advertised. Storefront MCP tools may add only explicitly allowlisted public read-only catalog tools, including `catalog_categories`, and the read-only cart-validation surface; do not advertise `catalog_categories` as a UCP capability and do not add cart mutation or transaction capability.
- Storefront MCP release proof must execute the public wrappers, not only inspect `tools/list`: `catalog_profile`, `catalog_categories`, `storefront_discovery_policy`, `catalog_search`, `cart_validate`, and `catalog_lookup`/`catalog_product` when search returns a product candidate. MCP initialize, initialized notification, tools/list, and every tool call must be `Cache-Control: no-store`.
- Storefront page tools must refuse off-origin navigation and must not read private customer/order/session data.
- MCP errors and logs must use masked metadata only. No OTPs, credentials, receipt proofs, provider payloads, raw phone/email, or buyer PII.

## Verification Gates

Minimum local gates for the first tracked agent Worker:

- `pnpm --filter @scalius/agent typecheck`
- `pnpm --filter @scalius/agent lint`
- `pnpm --filter @scalius/agent test`
- `pnpm --filter @scalius/agent build`
- `pnpm run deploy:agent -- --dry-run`
- `pnpm check:env`
- MCP Inspector or equivalent JSON-RPC smoke for both MCP route groups, including public agent-host `/mcp/admin` rejection, public Storefront MCP wrapper execution, and dashboard-proxied Admin MCP initialize/tools/list/call proof
- Admin 401/403/RBAC/2FA/onboarding tests
- Storefront catalog, compact category, public discovery-policy, and read-only cart-validation tool tests
- Browser smoke: admin assistant can read page state and navigate without console errors
- Browser smoke: storefront assistant can read public product/cart-validation context without private data exposure

Deploy only after those pass. Live proof must include API health/readyz, agent Worker route smoke, admin auth failure smoke, storefront UCP catalog-only smoke, and `pnpm ops:check --queues` if queue/agent bindings changed.

## Implementation Ownership

Split future work by disjoint write scopes:

- Agent platform worker: `apps/agent/package.json`, `apps/agent/**`, deploy/env wiring.
- Admin MCP worker: `apps/agent/src/mcp/admin/**`, allowlists, admin API request callback tests.
- Storefront MCP worker: `apps/agent/src/mcp/storefront/**`, UCP/feed wrappers, catalog and read-only cart-validation tests.
- Admin page-state worker: `apps/admin-v2/src/components/admin/assistant/**`, admin shell integration, shared form/table state registry.
- Storefront page-context worker: `apps/storefront/src/components/assistant/**`, product/cart context bridge.
- Model settings worker: existing AI settings core/API/admin UI only.
- Verification worker: MCP Inspector smokes, browser smokes, deploy docs.

Keep implementation boring: no browser DOM scraping when shared forms/tables can register state, no direct database access from the agent Worker, no model-selected privileged URLs, and no hidden commerce mutations.
