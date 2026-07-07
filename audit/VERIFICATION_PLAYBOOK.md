# Verification Playbook

This repo is hard to run end to end locally. Use this playbook to prove one slice at a time, and record exactly what was and was not verified.

## Baseline Commands

Run these before broad future remediation work or re-audits:

```bash
git status --short
pnpm typecheck
pnpm exec drizzle-kit check --config packages/database/drizzle.config.ts
pnpm --filter @scalius/database check:migrations
pnpm check:env
pnpm audit --audit-level moderate
pnpm test
```

Current expected result:

- `pnpm typecheck` passes.
- Drizzle check passes.
- Database migration metadata guard passes.
- Worker Env declaration guard passes.
- Dependency audit reports no known moderate-or-higher vulnerabilities.
- Root tests currently pass with `pnpm test`.
- `pnpm outdated -r` is informational, not a pass/fail gate. Use a fresh run before dependency sweeps; storefront is on Astro 7 / `@astrojs/cloudflare` 14 / Vite 8.1 with Wrangler 4.103.0, so dependency sweeps must include `pnpm peers check`, storefront typecheck/build, generated Wrangler dry-run, local dev smoke, and generated Worker smoke.
- Keep ESLint and Prettier for now. Oxfmt can be evaluated as an additive formatter experiment, but do not replace `prettier-plugin-astro` until Oxfmt supports Astro/Prettier plugins and a focused dual-run diff proves formatting parity.

## Operational Readiness

Deep API readiness is exposed at:

```bash
pnpm ops:check
pnpm ops:check --json
pnpm ops:check --queues
pnpm release:check
pnpm release:check --json
curl -fsS https://api.scalius.com/api/v1/readyz
```

Expected healthy result: HTTP `200`, `Cache-Control: no-store`, `success: true`, `status: "ready"`, and `checks` entries for `d1`, `api_cache_kv`, `shared_auth_kv`, `r2`, `widget_design_agent_do`, `payment_events_queue`, `order_notifications_queue`, `auth_otp_queue`, `storefront_cache_queue`, and `runtime_config` all reporting `status: "ok"`. Runtime config includes the storefront purge URL/token because cache freshness is now a deploy-readiness dependency. D1, KV, and R2 probes share a 5s remote-storage timeout; D1 also retries known transient Cloudflare D1 overload/queue-timeout errors. Persistent storage failures must still return degraded.

Expected degraded result: HTTP `503`, `success: false`, `status: "degraded"`, and a per-check `status` of `missing`, `error`, or `timeout`. The endpoint must stay read-only: D1 uses `SELECT 1`, KV uses a read probe, R2 uses `list({ limit: 1 })`, and Queue/DO checks are binding-shape checks only.

`pnpm ops:check`, `pnpm release:check`, and API deploy verification all use the same four-sample `/readyz` recovery window by default: the final sample must be ready and at least two samples must be ready. `pnpm release:check` also validates emitted homepage OnlineStore/WebSite/SearchAction/MerchantReturnPolicy JSON-LD, then validates the storefront UCP profile as HTTPS/catalog-only and runs read-only UCP catalog search/lookup/product checks when discovery exposes a product candidate.

Every API HTTP response should carry `X-Request-Id`; preserve a safe caller-supplied value during smoke tests when you want to match client output to Worker logs. Structured API ops logs include `requestId` and Cloudflare `cfRay` when available. Alert on repeated `api.readyz.degraded` events by required-check status, then use the same request id/CF-Ray to inspect the matching Worker invocation without exposing secrets or buyer data.

Operational runbook: see [OPERATIONAL_RUNBOOK.md](OPERATIONAL_RUNBOOK.md) for concrete alert signals, read-only live smoke commands, queue/DLQ backlog checks, scheduled-maintenance checks, and deploy/rollback investigation pointers. Monitoring contract: see [ops-monitoring-contract.md](ops-monitoring-contract.md) for the Cloudflare-native scheduled ops monitor and completion checklist. The deployed monitor is a tiny scheduled Worker with no public route: call `/readyz`, read queue/DLQ backlog through `Queue.metrics()` bindings, persist KV streak/cooldown state, and emit structured redacted logs. Cloudflare Health Checks are useful outside-in for `/readyz`, but they do not cover queue/DLQ backlog by themselves.

API deploy verification:

```bash
pnpm run deploy:api
```

Expected deploy proof after the Worker upload: latest API deployment serves one version at `100%`, `/api/v1/health` returns `200`, and the deploy script samples `/api/v1/readyz` four times. A single transient dependency timeout can pass only when the recovery window ends ready and at least two samples are ready; persistent degraded readiness must fail the deploy verification.

Focused local test:

```bash
node --check scripts/ops-check.mjs
node --check scripts/release-check.mjs
pnpm exec vitest run scripts/ops-check.test.mjs scripts/release-check.test.mjs scripts/deploy.test.mjs --passWithNoTests
pnpm --filter @scalius/api exec vitest run src/routes/readiness.test.ts --passWithNoTests
```

Ops monitor verification:

```bash
pnpm --filter @scalius/ops-monitor test
pnpm --filter @scalius/ops-monitor typecheck
pnpm --filter @scalius/ops-monitor build
pnpm deploy:ops-monitor
pnpm ops:check --queues --samples 1 --timeout-ms 20000
```

Required evidence before closing OPS-005/OPS-008 monitoring scope: deployed ops-monitor Worker version, ops-monitor cron schedule (`*/2 * * * *`), no-public-route confirmation, KV binding for streak/cooldown state, Cloudflare Email Service `ALERT_EMAIL` binding, every normal/DLQ queue binding, Wrangler tail or Workers Logs showing scheduled `/readyz` checks and `Queue.metrics()` summaries, redacted structured log examples, and routed Cloudflare Email Service proof. Keep this distinct from the API scheduled-maintenance cron (`*/15 * * * *`). The monitor logs `alertCount`, `routedAlertCount`, and `deliveryFailureCount`; do not treat logs-only alert events as routed notification success. Logs-only monitoring is acceptable as an intermediate slice, but the tracker must keep alert-channel verification open until a verified sender/destination test notification is recorded without secrets or inbox screenshots.

`pnpm ops:check --queues` fails when expected API queue producers/consumers are
missing. Extra provider actors are warning-level evidence in logs/JSON, so a
stale Worker such as an old test deployment should be cleaned up without
confusing that cleanup with a failed queue-wiring smoke.

## Storefront Listing Query Plans

Use this after changing product listing SQL, product/category/attribute indexes, or storefront filter handling:

```bash
pnpm --filter @scalius/api exec wrangler d1 execute scalius-commerce --remote --command "EXPLAIN QUERY PLAN SELECT p.id FROM products p WHERE p.is_active = 1 AND p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 20;"
pnpm --filter @scalius/api exec wrangler d1 execute scalius-commerce --remote --command "EXPLAIN QUERY PLAN SELECT p.id FROM products p WHERE p.category_id = 'cat_jt08vpZjE-s8YMyCK2Vzp' AND p.is_active = 1 AND p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 20;"
pnpm --filter @scalius/api exec wrangler d1 execute scalius-commerce --remote --command "EXPLAIN QUERY PLAN SELECT pav.product_id FROM product_attribute_values pav INNER JOIN product_attributes pa ON pav.attribute_id = pa.id WHERE pa.slug = 'brand' AND pav.value = 'Apple';"
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/products?page=1&limit=20&sort=newest'
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/products?page=1&limit=20&sort=newest&brand=Apple'
curl -sS -o /tmp/scalius-storefront-search.html -w 'HTTP %{http_code} time %{time_total} size %{size_download}\n' 'https://storefront.scalius.com/search?sortBy=newest'
curl -sS -o /tmp/scalius-storefront-search-brand-apple.html -w 'HTTP %{http_code} time %{time_total} size %{size_download}\n' 'https://storefront.scalius.com/search?brand=Apple'
```

Expected D1 plan shape: global newest uses `products_public_newest_idx` without `USE TEMP B-TREE FOR ORDER BY`; category newest uses `products_public_category_newest_idx` without a temp sort; a single attribute filter uses `product_attributes_slug_idx` plus covering `product_attribute_values_attr_value_product_idx` without a temp group. Re-run with a fresh production category/filter pair if demo data changes.

## Public Search Cache And Cost Policy

Use this after changing public search, storefront listing filters, cache key canonicalization, FTS helpers, or public list limits:

```bash
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/search?q=!!!!'
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/search?q=fish&limit=5000'
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/search?q=fish&limit='
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/search?q=%20fish%20%20curry%20&limit=4'
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/products?search=!!!!&freeDelivery=false'
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/products?limit=5000'
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/products?limit='
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/products?page=1001'
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/products/search?search=%20%20%20&limit=4'
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/products/search?search=!!!!&limit=4'
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/products/search?page=1001'
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/categories/drinks/products?search=!!!!'
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/categories/drinks/products?limit='
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/categories/drinks/products?page=1001'
curl -sS -w '\nHTTP %{http_code} time %{time_total}\n' 'https://api.scalius.com/api/v1/attributes/search-filters?q=!!!!'
```

Expected result: punctuation-only public FTS queries return successful empty data instead of broad catalog/listing reads; whitespace-only `/products/search` behaves like blank search; excessive or empty numeric params return `400`; public page numbers above `1000` return `400`; normalized whitespace queries return the canonical query text; and category/listing invalid searches do not report an applied search filter. Cache hits for `/api/v1/search` intentionally bypass the miss-only search limiter so hot public search reads stay cheap; invalid raw query shapes must bypass cache before validation; valid cache misses are rate-limited before DB/FTS work. Keep this policy covered by `apps/api/src/routes/search.test.ts`, `apps/api/src/utils/public-search-query.test.ts`, route-boundary tests, and core storefront product boundary tests.

## Focused Typecheck Commands

```bash
pnpm --filter @scalius/api typecheck
pnpm --filter @scalius/admin-v2 typecheck
pnpm --filter @scalius/storefront typecheck
pnpm --filter @scalius/core typecheck
pnpm --filter @scalius/database typecheck
```

Note: admin server functions now live under `apps/admin-v2/src/lib/api-functions/`; keep new slices covered by normal admin typecheck and avoid file-level `@ts-nocheck`.

## Focused Test Patterns

API routes:

```bash
pnpm --filter @scalius/api test -- src/routes/path/to/test.ts
```

Core services:

```bash
pnpm --filter @scalius/core test -- src/modules/domain/domain.test.ts
```

Admin components:

```bash
pnpm exec vitest run apps/admin-v2/src/path/to/test.ts
```

Admin order detail:

```bash
pnpm exec vitest run apps/admin-v2/src/routes/admin/orders/-order-detail-prefetch.test.ts
pnpm --filter @scalius/admin-v2 typecheck
```

Expected result: order and shipment prefetches remain required for a real order detail render, but delivery-provider, payment-history, currency, and COD warmups are optional. A delivery-provider prefetch failure should log `Order delivery provider prefetch skipped` and keep the order detail route loadable with an empty provider fallback.

Admin shell/list routing:

```bash
pnpm exec vitest run apps/admin-v2/src/lib/admin-access.test.ts apps/admin-v2/src/routes/api/scanner-token.test.tsx
pnpm --filter @scalius/admin-v2 typecheck
```

Admin performance hot-path checks:

```bash
pnpm exec vitest run \
  apps/admin-v2/src/lib/route-graph-boundaries.test.ts \
  'apps/admin-v2/src/routes/admin/products/$productId/-edit-boundaries.test.ts' \
  apps/admin-v2/src/components/admin/navigation/NavigationBuilder-boundaries.test.ts \
  apps/admin-v2/src/components/admin/product-form/variants/VariantManager-boundaries.test.ts \
  apps/admin-v2/src/routes/admin/settings/-checkout-loader.test.ts
! test -e apps/admin-v2/src/lib/api.queries.ts
! rg "from ['\\\"](?:~/|@/)lib/api\\.queries|from ['\\\"](?:\\.\\.?/)+(?:lib/)?api\\.queries" \
  apps/admin-v2/src \
  -g '*.ts' \
  -g '*.tsx'
! rg "api\\.queries" apps/admin-v2/src/lib/api-query-options
! rg "import \\{[^}]*RouteErrorComponent[^}]*\\} from ['\\\"]~\\/lib\\/list-helpers['\\\"]" \
  apps/admin-v2/src/routes/admin
rg -n 'warmRouteQuery' \
  apps/admin-v2/src/routes/admin/products/index.tsx \
  apps/admin-v2/src/routes/admin/orders/index.tsx \
  apps/admin-v2/src/routes/admin/customers/index.tsx \
  apps/admin-v2/src/routes/admin/categories/index.tsx \
  apps/admin-v2/src/routes/admin/collections/index.tsx \
  apps/admin-v2/src/routes/admin/discounts/index.tsx \
  apps/admin-v2/src/routes/admin/pages/index.tsx \
  apps/admin-v2/src/routes/admin/widgets/index.tsx
rg -n 'placeholderData: keepPreviousData|refetchOnMount: "always"' apps/admin-v2/src/components/admin/data-table/useServerTable.ts
rg -n 'clearAdminRouteContextCache' \
  apps/admin-v2/src/components/admin/account-settings/ProfileHeader.tsx \
  apps/admin-v2/src/components/admin/account-settings/TwoFactorSetup.tsx \
  apps/admin-v2/src/components/auth/UserMenu.tsx
rg -n 'queryKeys\\.dashboard\\.all|invalidateDashboardQueries' \
  apps/admin-v2/src/lib/api-mutations \
  apps/admin-v2/src/routes/admin/orders/index.tsx
rg -n 'queryKeys\\.products\\.stats\\(\\)|invalidateProductStatsQueries' \
  apps/admin-v2/src/lib/api-mutations \
  apps/admin-v2/src/components/admin/CategoryForm.tsx \
  apps/admin-v2/src/components/admin/product-form/OrganizationCard.tsx
! rg 'motion/react' \
  apps/admin-v2/src/components/admin/DashboardStats.tsx \
  apps/admin-v2/src/components/admin/WelcomeBanner.tsx \
  apps/admin-v2/src/components/ui/background-gradient.tsx \
  apps/admin-v2/src/components/ui/container-text-flip.tsx
! rg '@dnd-kit|useSortable|DndContext|SortableContext|sortableKeyboardCoordinates' apps/admin-v2/src/components/admin/data-table/DataTable.tsx
rg -n '@dnd-kit|useSortable|DndContext|SortableContext|sortableKeyboardCoordinates' apps/admin-v2/src/components/admin/data-table/SortableDataTableContent.tsx
rg -n 'LazyMediaManager|lazy\\(\\(\\) => import\\("\\./MediaManager"\\)\\)' apps/admin-v2/src/components/admin/media-manager
rg -n 'DeferredTiptapEditor' \
  apps/admin-v2/src/components/admin/ProductForm.tsx \
  apps/admin-v2/src/components/admin/CategoryForm.tsx \
  apps/admin-v2/src/components/admin/PageForm.tsx \
  apps/admin-v2/src/components/admin/footer-builder/ContentSection.tsx \
  apps/admin-v2/src/components/admin/product-form
rg -n 'lazy\\(\\(\\) => import\\("\\./AdditionalInfoManager"|lazy\\(\\(\\) => import\\("../DraggableImageGallery"\\)' \
  apps/admin-v2/src/components/admin/product-form/TitleDescriptionSection.tsx \
  apps/admin-v2/src/components/admin/product-form/ProductImagesSection.tsx
! rg 'import .*AdditionalInfoManager|import .*DraggableImageGallery|@dnd-kit|sortableKeyboardCoordinates|DndContext|SortableContext' \
  apps/admin-v2/src/components/admin/product-form/TitleDescriptionSection.tsx \
  apps/admin-v2/src/components/admin/product-form/ProductImagesSection.tsx
rg -n 'lazy\\(\\(\\) =>' \
  apps/admin-v2/src/components/admin/product-form/variants/VariantManager.tsx \
  apps/admin-v2/src/components/admin/product-form/variants/VariantActionsToolbar.tsx
rg -n 'import\\("\\./VariantSortModal"|import\\("\\./bulk-generator"|import\\("\\./utils/csvHelpers"\\)' \
  apps/admin-v2/src/components/admin/product-form/variants/VariantManager.tsx \
  apps/admin-v2/src/components/admin/product-form/variants/VariantActionsToolbar.tsx \
  apps/admin-v2/src/components/admin/product-form/variants/VariantImportExport.tsx
! rg 'import \\{ .*BulkVariantGenerator|import \\{ .*VariantSortModal|export \\{ BulkVariantGenerator|export \\{ VariantSortModal|export \\* from "\\./utils/csvHelpers"' \
  apps/admin-v2/src/components/admin/product-form/variants \
  --glob '!**/bulk-generator/index.ts'
pnpm exec vitest run apps/admin-v2/src/components/admin/product-form/variants/utils/csvHelpers.test.ts --passWithNoTests
rg -n 'import\("\./(NavigationSection|SocialLinksSection|NavigationMenusSection)"\)' \
  apps/admin-v2/src/components/admin/header-builder/HeaderBuilder.tsx \
  apps/admin-v2/src/components/admin/footer-builder/FooterBuilder.tsx
! rg 'export \{ (BrandingSection|TopBarSection|ContactSection|SocialLinksSection|NavigationSection|ContentSection|NavigationMenusSection)' \
  apps/admin-v2/src/components/admin/header-builder/index.ts \
  apps/admin-v2/src/components/admin/footer-builder/index.ts
! rg '<TiptapEditor|React\\.lazy\\(\\(\\) => import\\([^\\n]*tiptap|useEditor|EditorContent' \
  apps/admin-v2/src/components/admin/ProductForm.tsx \
  apps/admin-v2/src/components/admin/CategoryForm.tsx \
  apps/admin-v2/src/components/admin/PageForm.tsx \
  apps/admin-v2/src/components/admin/footer-builder/ContentSection.tsx \
  apps/admin-v2/src/components/admin/product-form
rg -n 'lazy\\(\\(\\) => import\\("\\./widget-form/(FullScreenEditor|WidgetHistoryModal|WidgetPasteModal)"' apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx
rg -n 'import\\("@scalius/core/modules/ai/prompt-helper-v2"\\)|import\\("\\./standalone-prompt"\\)' apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts
pnpm --filter @scalius/admin-v2 typecheck
pnpm --filter @scalius/admin-v2 lint
pnpm --filter @scalius/admin-v2 build
node - <<'NODE'
const { readFileSync } = require("node:fs");
const manifest = JSON.parse(
  readFileSync("apps/admin-v2/dist/server/.vite/manifest.json", "utf8"),
);
const hotEntries = Object.entries(manifest).filter(
  ([key]) => key.includes("routes/admin/index") || key.includes("routes/admin/settings"),
);
for (const [key, value] of hotEntries) {
  const blob = JSON.stringify(value);
  if (blob.includes("list-helpers") || blob.includes("api.queries")) {
    throw new Error(`${key} still references list-helpers/api.queries`);
  }
}
console.log({ checked: hotEntries.length });
NODE
find apps/admin-v2/dist/client/assets \( -name 'ProductForm-*.js' -o -name 'CategoryForm-*.js' -o -name 'PageForm-*.js' -o -name 'footer-builder-*.js' \) -print0 | xargs -0 rg 'useEditor|EditorContent|createTiptapExtensions|prosemirror' || true
find apps/admin-v2/dist/client/assets -maxdepth 1 -type f \( -name '*Tiptap*' -o -name '*DeferredTiptap*' \) -exec ls -lh {} +
node - <<'NODE'
const fs = require("fs");
const dir = "apps/admin-v2/dist/client/assets";
const file = fs.readdirSync(dir).find((name) => /^ProductForm-.*\.js$/.test(name));
if (!file) throw new Error("ProductForm chunk not found");
const src = fs.readFileSync(`${dir}/${file}`, "utf8");
const imports = [...src.matchAll(/import[^;]+from"\.\/([^"]+)"/g)].map((match) => match[1]);
const forbidden = imports.filter((name) => /sortable|AdditionalInfoManager|DraggableImageGallery|TiptapEditor|prosemirror/i.test(name) && !/DeferredTiptapEditor/i.test(name));
if (forbidden.length) throw new Error(`Unexpected static ProductForm imports: ${forbidden.join(", ")}`);
console.log({ file, bytes: src.length });
NODE
node - <<'NODE'
const fs = require("fs");
const path = require("path");
const files = [
  ...fs.readdirSync("apps/admin-v2/dist/client/assets").filter((file) => /^(edit|ProductForm)-.*\.js$/.test(file)).map((file) => path.join("apps/admin-v2/dist/client/assets", file)),
  ...fs.readdirSync("apps/admin-v2/dist/server/assets").filter((file) => /^(edit|ProductForm)-.*\.js$/.test(file)).map((file) => path.join("apps/admin-v2/dist/server/assets", file)),
];
const blocked = /bulk-generator|VariantSortModal|csvHelpers/;
for (const file of files) {
  const code = fs.readFileSync(file, "utf8");
  const staticImports = [...code.matchAll(/import\s+(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]);
  const bad = staticImports.filter((specifier) => blocked.test(specifier));
  if (bad.length) throw new Error(`${file} statically imports ${bad.join(", ")}`);
}
console.log({ checked: files.length });
NODE
node - <<'NODE'
const fs = require("fs");
const path = require("path");
const assets = [
  ["client", "apps/admin-v2/dist/client/assets"],
  ["server", "apps/admin-v2/dist/server/assets"],
];
const blocked = /NavigationBuilder|NavigationMenusSection|SocialLinksSection|sortable\.esm|AddNavItemDialog/;
let checked = 0;
for (const [, dir] of assets) {
  for (const name of fs.readdirSync(dir)) {
    if (!/^(header-builder|footer-builder)-.*\.js$/.test(name)) continue;
    checked++;
    const file = path.join(dir, name);
    const code = fs.readFileSync(file, "utf8");
    const staticImports = [...code.matchAll(/import\s+(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]);
    const bad = staticImports.filter((specifier) => blocked.test(specifier));
    if (bad.length) throw new Error(`${file} statically imports ${bad.join(", ")}`);
  }
}
if (checked === 0) throw new Error("No header/footer builder chunks found");
console.log({ checked });
NODE
node - <<'NODE'
const fs = require("fs");
const path = require("path");
const roots = ["apps/admin-v2/dist/client/assets", "apps/admin-v2/dist/server/assets"];
const productEditFiles = [];
for (const root of roots) {
  for (const file of fs.readdirSync(root)) {
    if (/^(edit|ProductForm)-.*\.js$/.test(file)) productEditFiles.push(path.join(root, file));
  }
}
const staticImport = /import\s+(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g;
const blocked = /bulk-generator|VariantSortModal|csvHelpers|VariantImportExport/;
for (const file of productEditFiles) {
  const imports = [...fs.readFileSync(file, "utf8").matchAll(staticImport)].map((match) => match[1]);
  const bad = imports.filter((specifier) => blocked.test(specifier));
  if (bad.length) throw new Error(`${file} statically imports ${bad.join(", ")}`);
}
const navigationFiles = [];
for (const root of roots) {
  for (const file of fs.readdirSync(root)) {
    if (/^NavigationBuilder-.*\.js$/.test(file)) navigationFiles.push(path.join(root, file));
  }
}
for (const file of navigationFiles) {
  const imports = [...fs.readFileSync(file, "utf8").matchAll(staticImport)].map((match) => match[1]);
  const bad = imports.filter((specifier) => /SortableNavigationEditor|SortableNavItem|@dnd-kit|sortable/.test(specifier));
  if (bad.length) throw new Error(`${file} statically imports ${bad.join(", ")}`);
}
console.log({ productEditFiles: productEditFiles.length, navigationFiles: navigationFiles.length });
NODE
```

Expected result: the checkout settings route loader warms only `authSettingsQueryOptions()`. It must not preload payment methods or shipping methods for inactive tabs, route-facing query options should live in narrow `api-query-options/*` modules, the broad `api.queries.ts` barrel must not exist, and routes should import `RouteErrorComponent` from `route-error.tsx` instead of Zod-backed `list-helpers.tsx`. List route loaders should use `warmRouteQuery()` for non-blocking client navigation, while `useServerTable()` must keep cached rows visible and refetch on mount for freshness. Current-user profile/2FA/session paths must clear the admin route-context cache before route invalidation. Product/customer/order mutations and direct form submit paths must invalidate dashboard aggregate keys, and category mutations/direct category creation paths must invalidate product stats. Dashboard first-paint components should not import `motion/react`. The shared `DataTable` default path must not import `@dnd-kit`/sortable code; those imports should live only in `SortableDataTableContent`, and browser request capture should prove `/admin/orders` does not request it while drag-enabled `/admin/collections?sort=sortOrder&order=asc` does. Media picker consumers should hit the lightweight `LazyMediaManager` wrapper until the picker is clicked. Lower-priority rich-text fields should render saved read-only content through the sanitized `DeferredTiptapEditor`/`RichContent` preview, and their production form chunks should not contain Tiptap internals such as `useEditor`, `EditorContent`, ProseMirror, or `createTiptapExtensions`. The primary product description is the exception after the flicker regressions: it may use the real `TiptapEditor` path directly, but must keep a stable sanitized shell before editor activation and remain covered by product-edit boundary tests. Product form first load should have no static import of `AdditionalInfoManager`, `DraggableImageGallery`, or sortable dependencies; those may appear only as lazy dependency metadata/chunks. Product edit SSR should return the document without rendering the heavy option manager, then hydrate `Product Options` in the browser. Product variant edit first load should have no static import of `bulk-generator`, `VariantSortModal`, `VariantImportExport`, or `csvHelpers`; clicking `Bulk Generate`, `Import/Export CSV`, or `Reorder` should load the needed tool on demand and still open the expected dialog/action. `NavigationBuilder` should render compact non-DnD rows by default and lazy-load sortable navigation only after `Reorder`. General Settings Header/Footer first load should have no static import of header social, header navigation, footer social, footer navigation menus, `NavigationBuilder`, or sortable dependencies; clicking the relevant Header/Footer subtabs should load and render those sections on demand. Widget editor/history/paste/prompt helper chunks should load only after preview/history/paste/copy-prompt actions. Local browser smokes should cover `/admin/products/new` media picker, product image/additional-info lazy shells, and rich-text edit shell; `/admin/products/:id/edit` variant `Bulk Generate` and `Reorder`; `/admin/categories/new` rich-text edit shell; `/admin/pages/new` rich-text edit shell; `/admin/media`; `/admin/settings/hero-sliders` custom `Add Slide Image` picker; `/admin/settings` Header Contact & Social, Header Navigation, Footer Branding, and Footer Navigation Menus; and `/admin/widgets/create` paste/preview/copy-prompt.

Admin mutation-barrel split checks:

```bash
! rg "from ['\"][~@]/lib/api\\.mutations|~/lib/api\\.mutations|@/lib/api\\.mutations" apps/admin-v2/src
rg -n '^export \* from "\./api-mutations/' apps/admin-v2/src/lib/api.mutations.ts
rg -n "from ['\"][~@]/lib/api-mutations" apps/admin-v2/src
pnpm --filter @scalius/admin-v2 typecheck
pnpm --filter @scalius/admin-v2 lint
pnpm --filter @scalius/admin-v2 build
```

Expected result: route-reachable components import mutation hooks from domain modules under `apps/admin-v2/src/lib/api-mutations/*`. The legacy `api.mutations.ts` compatibility barrel should contain only domain `export *` lines and no route/component under `apps/admin-v2/src` should import it directly.

Admin 2FA/setup auth boundary:

```bash
pnpm exec vitest run apps/admin-v2/src/lib/api.server.test.ts apps/api/src/middleware/admin-auth.test.ts apps/api/src/routes/admin/auth-management.test.ts
pnpm --filter @scalius/api typecheck
pnpm --filter @scalius/admin-v2 typecheck
rg -n 'mark2faVerified|mark-verified|markFirstUserAsSuperAdmin' apps/admin-v2/src apps/api/src packages/core/src
rg -n 'trustDevice: true|trustDevice\\?: boolean' apps/api/src/routes/admin/auth-management.ts apps/admin-v2/src/components/auth apps/admin-v2/src/components/admin/account-settings
```

For `AUTH-002`, direct `mark-verified` calls must fail before RBAC, and `/2fa/complete-verification` must require a Better Auth session-token proof matching the current session and user. For `AUTH-003`, no browser-callable server function may promote an arbitrary email to super-admin; first-admin promotion belongs to `/api/v1/setup`. For `AUTH-006`/`AUTH-010`, `/2fa/method` must either verify a code for the target method inside the API route or accept a same-origin Better Auth `sessionToken` proof matching the current session id, user id, and token. Session-rotating Better Auth calls must forward replacement `Set-Cookie` headers through both the API worker and admin server-function response. A browser-only prior verification without API proof is not enough. For `AUTH-011`, remembered-device login remains disabled: UI calls should send `trustDevice: false`, `/api/v1/admin/auth/2fa/verify` must reject `trustDevice: true`, and same-origin Better Auth catch-all verification paths must reject direct `trustDevice: true` requests before calling Better Auth.

Admin server-function slice changes:

```bash
pnpm --filter @scalius/admin-v2 typecheck
pnpm --filter @scalius/admin-v2 lint
git diff --check
rg -n "\b(exportNameOne|exportNameTwo)\b" apps/admin-v2/src --glob '!routeTree.gen.ts'
rg -n "as unknown as|legacyPayloadName" touched/file/one.ts touched/file/two.ts
```

For server-function slices, check the API route request schema and remember that `apps/admin-v2/src/lib/api.server.ts` unwraps `{ success, data }`; type the returned inner `data` shape, not the whole envelope.

Storefront tests:

```bash
pnpm --filter @scalius/storefront exec vitest run src/path/to/test.ts --passWithNoTests
```

Focused storefront Vitest now starts after adding the missing `happy-dom` dev dependency.

Storefront checkout/content/SEO regression checks:

```bash
pnpm --filter @scalius/storefront exec vitest run src/lib/checkout/render-summary.test.ts src/lib/safe-json.test.ts src/lib/cart/client.test.ts src/lib/seo-regressions.test.ts src/components/LocationSelector.test.ts
pnpm --filter @scalius/core test -- src/modules/pages/pages.service.test.ts
pnpm --filter @scalius/storefront typecheck
```

For `STORE-005`, executable inline JSON must use `serializeJsonForInlineScript()` and include a DOM-parser test with a `</script>` payload. For `STORE-006`, localized/admin-configured empty-cart strings must render through text nodes, and the test must assert malicious language strings do not create `img` or `script` nodes.

Storefront checkout/privacy regression checks:

```bash
pnpm --filter @scalius/storefront exec vitest run src/lib/tracking/meta-capi.test.ts src/lib/checkout/session-state.test.ts src/lib/checkout/render-summary.test.ts --passWithNoTests
pnpm --filter @scalius/storefront typecheck
```

For `PRIV-002`, broad Meta CAPI events must not inherit checkout/customer PII from `sessionStorage`; legacy `scalius_user_*` keys must be removed by checkout cleanup. Historical SSLCommerz/Polar checks that preserved cart contents after gateway session creation are superseded by `CHECKOUT-011`: after a durable hosted order commit, recovery continues through the receipt/order path and the short-lived empty-cart recovery marker.

Receipt-proof URL safety checks:

```bash
pnpm --filter @scalius/storefront exec vitest run src/lib/order-success-state.test.ts src/lib/order-success-payment-retry.test.ts src/lib/checkout/handlers/online-payment-handlers.test.ts src/lib/route-tests/api/checkout/payment-session-proxies.test.ts --passWithNoTests
pnpm --filter @scalius/api exec vitest run src/routes/orders-receipt.test.ts src/routes/payment/payment-session.test.ts src/routes/webhooks/sslcommerz.test.ts src/routes/webhooks/polar.test.ts --passWithNoTests
pnpm --filter @scalius/core test -- src/modules/orders/order-receipts.test.ts src/modules/orders/order-payment-recovery-link.test.ts
```

For `PRIV-003`, receipt proof remains required for guest receipt/payment recovery, but bearer proof must not travel in URLs. Public order-success URLs, receipt API calls from the browser, SSLCommerz success/fail/cancel redirects, Polar success URLs, payment-recovery links, and same-origin payment-session proxies must avoid `token`, `receipt_token`, or `receiptToken` URL parameters. Use same-origin httpOnly cookies plus POST body or header proof forwarding with explicit expiry, origin checks, and no raw proof in KV keys, logs, analytics, or clipboard URLs. Admin recovery copy links are clean same-browser receipt URLs only; merchant-sendable cross-browser recovery requires `POSTSALE-021`, not a renamed bearer URL. Keep backend callback validation deterministic and ensure live read-only smokes prove receipt access still fails closed without proof.

Payment settings and checkout-cache checks:

```bash
pnpm --filter @scalius/api exec vitest run src/routes/admin/settings/payments.test.ts src/utils/cache-invalidation.test.ts
pnpm --filter @scalius/core exec vitest run src/modules/settings/checkout-config.service.test.ts
pnpm --filter @scalius/api typecheck
pnpm --filter @scalius/core typecheck
```

For `CACHE-001`, payment-method, Stripe, SSLCommerz, and Polar settings writes must invalidate the API `checkout` cache group and purge storefront checkout prefixes. Public checkout config must treat `payment_methods.enabled_methods` as the outer allowlist while still filtering disabled/unconfigured gateways.

Admin/storefront cache invalidation checks:

```bash
pnpm --filter @scalius/api exec vitest run src/utils/cache-invalidation.test.ts src/routes/admin/settings/site-cache-invalidation.test.ts src/routes/admin/navigation.test.ts src/routes/checkout-languages.test.ts src/routes/admin/attributes-cache-invalidation.test.ts src/routes/admin/settings/shipping-cache-invalidation.test.ts src/routes/admin/settings/hero-sliders-cache-invalidation.test.ts src/routes/admin/settings/delivery-locations-cache-invalidation.test.ts src/routes/admin/settings/delivery-providers-cache-invalidation.test.ts
pnpm --filter @scalius/api typecheck
pnpm --filter @scalius/admin-v2 typecheck
```

For `CACHE-003`/`CACHE-008`/`CACHE-013`/`CACHE-014`, non-widget admin writes for shipping methods, delivery providers, delivery locations, checkout languages, navigation, analytics, site settings, hero sliders, security settings, and attributes must invalidate the right API KV group and trigger the matching storefront purge group. Delivery-provider writes are checkout-affecting and must invalidate `["checkout"]`; the admin delivery-provider UI must invalidate `queryKeys.settings.deliveryProviders()` after successful saves/deletes. Hero slider create/update/delete must invalidate homepage API KV and schedule the storefront purge defensively; hero slider reads must not purge. Security/CSP writes must invalidate `["layout"]` and must not require a Hono `ExecutionContext` just to cache `security:csp_allowed_domains`. Widget target-aware purge narrowing is tracked separately as `CACHE-004`.

Storefront purge route checks:

```bash
pnpm --filter @scalius/storefront exec vitest run src/pages/api/purge-cache.test.ts src/lib/cache-purge-policy.test.ts --passWithNoTests
pnpm exec vitest run --config apps/api/vitest.config.ts apps/api/src/utils/cache-invalidation.test.ts
curl -i https://storefront.scalius.com/api/purge-cache
```

Expected result: `GET /api/purge-cache` is non-mutating and returns `405 Allow: POST` unless rejecting query-string credentials with `400`; it must not read/write the KV cache-version key, clear L1, or warm pages. `POST /api/purge-cache` remains the mutating path. Full/HTML-affecting direct purges bump the KV version, clear L1, and warm critical pages. Queue-driven purges send `warm:false`, then enqueue `storefront.cache_warm` only after purge success so retrying a warm failure cannot repeat the purge or version bump. Exact warm paths are canonicalized/capped and queue-side warming must stay small-batched; retryable warm failures retry the warm message, while `404`/other non-retryable warm misses are logged and acknowledged.

Storefront cache queue recovery checks:

```bash
pnpm --filter @scalius/api test -- src/queue-consumer.test.ts src/routes/cache-storefront-dlq.test.ts src/routes/cache.test.ts
pnpm exec wrangler queues info storefront-cache-dlq --config apps/api/wrangler.jsonc
```

Expected result: `storefront-cache-dlq` has `scalius-api` as a consumer, DLQ messages are archived to `storefront_cache_queue_failures` before ack, archive failures retry with a long delay, and admin cache replay re-enqueues the original purge/warm payload instead of mutating storefront caches inline.

Widget cache invalidation checks:

```bash
pnpm --filter @scalius/api exec vitest run src/utils/cache-invalidation.test.ts src/routes/admin/widgets-cache-invalidation.test.ts
pnpm --filter @scalius/core typecheck
pnpm --filter @scalius/api typecheck
```

For `CACHE-004`, widget writes must derive invalidation from before/after widget placement snapshots. Homepage placements may warm/purge homepage prefixes, page placements with known slugs must purge exact page-render/API page prefixes, product/category/collection placements should purge exact `widgets_scope_*` prefixes, and inactive/draft widgets should not purge public storefront caches.

Storefront API contract checks:

```bash
pnpm --filter @scalius/storefront exec vitest run src/lib/api/client-url-policy.test.ts src/lib/checkout/render-summary.test.ts
pnpm --filter @scalius/storefront typecheck
pnpm --filter @scalius/api-client typecheck
pnpm --filter @scalius/api test -- src/routes/orders-create.test.ts
pnpm --filter @scalius/core test -- src/modules/orders/orders.ingest.test.ts src/modules/orders/orders.storefront.test.ts
rg -n 'discounts/usage|recordDiscountUsage\(' apps/storefront/src apps/api/src packages/core/src
```

SDK timestamp contract checks:

```bash
pnpm generate:sdk
pnpm --filter @scalius/api typecheck
pnpm --filter @scalius/api-client typecheck
pnpm --filter @scalius/storefront typecheck
rg -n 'string \| number \| unknown|string \| string \| unknown|number \| unknown' packages/api-client/src/generated/types.gen.ts
```

Notification and credential-encryption checks:

```bash
pnpm --filter @scalius/api test -- src/queue-consumer.test.ts src/utils/encryption-key.test.ts
pnpm --filter @scalius/core test -- src/modules/notifications/notifications.service.test.ts
pnpm --filter @scalius/core typecheck
pnpm --filter @scalius/api typecheck
pnpm --filter @scalius/admin-v2 typecheck
```

Payment-session, payment-webhook, shipping, and abandoned-checkout remediation checks:

```bash
# PAY-003/PAY-004/PAY-005 coverage
pnpm --filter @scalius/api test -- src/routes/payment/payment-session.test.ts src/routes/orders-receipt.test.ts
pnpm --filter @scalius/api exec vitest run src/routes/payment/payment-session.test.ts src/routes/webhooks/sslcommerz.test.ts
pnpm --filter @scalius/api exec vitest run src/utils/webhook-idempotency.test.ts src/routes/webhooks/stripe.test.ts src/routes/webhooks/sslcommerz.test.ts src/routes/webhooks/polar.test.ts src/routes/webhooks/steadfast.test.ts
pnpm generate:sdk
pnpm --filter @scalius/api typecheck
pnpm --filter @scalius/storefront typecheck
pnpm --filter @scalius/api-client typecheck

# ORDER-006 coverage
pnpm --filter @scalius/core test -- src/modules/orders/orders.storefront.test.ts
pnpm --filter @scalius/core typecheck

# ORDER-007 coverage
pnpm --filter @scalius/core exec vitest run src/modules/orders/orders.fulfillment.test.ts src/modules/delivery/tracking.test.ts src/modules/payments/polar.test.ts src/modules/payments/process-payment.test.ts
pnpm exec vitest run tests/unit/core/orders/update-order-atomicity.test.ts tests/unit/core/payments/refund-validation.test.ts
pnpm --filter @scalius/api exec vitest run src/routes/webhooks/steadfast.test.ts src/routes/admin/system-utils-safe-methods.test.ts src/scheduled-maintenance.test.ts
pnpm --filter @scalius/core typecheck
pnpm --filter @scalius/api typecheck

# ORDER-008 coverage
pnpm --filter @scalius/core exec vitest run src/modules/orders/orders.fulfillment.test.ts src/modules/delivery/tracking.test.ts src/modules/payments/process-payment.test.ts
pnpm --filter @scalius/api exec vitest run src/routes/payment/payment-session.test.ts
pnpm exec vitest run tests/unit/core/orders/update-order-atomicity.test.ts
pnpm --filter @scalius/database check:migrations
pnpm exec drizzle-kit check --config packages/database/drizzle.config.ts
pnpm typecheck

# ORDER-009 coverage
pnpm exec vitest run tests/unit/core/orders/update-order-atomicity.test.ts
pnpm --filter @scalius/core exec vitest run src/modules/orders/orders.fulfillment.test.ts src/modules/delivery/tracking.test.ts src/modules/payments/process-payment.test.ts
pnpm --filter @scalius/core typecheck

# ORDER-011 coverage
pnpm exec vitest run tests/unit/core/orders/update-order-atomicity.test.ts
pnpm exec vitest run tests/unit/core/inventory/reserve-deduct-release.test.ts
pnpm --filter @scalius/core typecheck
pnpm --filter @scalius/core lint

# DEL-002 coverage
pnpm --filter @scalius/core exec vitest run src/modules/delivery/delivery.service.test.ts
pnpm --filter @scalius/core typecheck
pnpm --filter @scalius/core lint

# ORDER-005 coverage
pnpm --filter @scalius/api test -- src/routes/admin/system-utils-safe-methods.test.ts src/scheduled-maintenance.test.ts
pnpm --filter @scalius/core test -- src/modules/orders/stale-incomplete-orders.test.ts src/modules/abandoned-checkout/abandoned-checkout-cleanup.test.ts
pnpm --filter @scalius/api typecheck
pnpm --filter @scalius/api lint
```

Admin hosted-payment recovery checks:

```bash
pnpm --filter @scalius/core test -- src/auth/rbac/route-permissions.test.ts
pnpm --filter @scalius/api test -- src/routes/admin/orders-boundaries.test.ts
pnpm exec vitest run apps/admin-v2/src/routes/admin/orders/-order-list-interactions.test.ts apps/admin-v2/src/lib/route-graph-boundaries.test.ts
pnpm generate:sdk
pnpm --filter @scalius/api typecheck
pnpm --filter @scalius/admin-v2 typecheck
```

Use the admin hosted-payment recovery checks to prove `/api/v1/admin/orders/payment-recovery` and `/api/v1/admin/orders/payment-recovery/export` are mapped to `orders.view`, declared before the dynamic order-id route, and export only sanitized recovery summary fields. The admin order list should call the server-backed recovery export when a payment-recovery filter is active, block bulk shipments for selected recovery rows before opening the shipment dialog, and keep abandoned-checkout hosted-payment archive delete controls hidden from view-only operators.

For live/admin-release smokes, also prove cookie-bearing admin API failures fail fast: an invalid `better-auth.session_token` against `/api/v1/admin/settings/site` should return `401` quickly, while a real dashboard session should read `/api/v1/admin/orders`, `/api/v1/admin/orders/payment-recovery`, and `/api/v1/admin/orders/payment-recovery/export` through both `api.scalius.com` and the dashboard proxy without hitting `ADMIN_API_READ_TIMEOUT`.

Use the PAY-003/PAY-004 checks to prove that payment-session routes reject missing or wrong receipt tokens before gateway calls, derive gateway URLs from trusted config, reject disabled or mismatched deposit attempts, ignore caller currency for session creation, and force public Stripe manual capture off. Use the PAY-005 SSLCommerz webhook checks to prove canonical validated transaction data is used instead of form metadata. Use the webhook-idempotency checks to prove fresh `processing` claims dedupe, stale `processing` claims are leased/reclaimable by only one retry, `failed` claims are reclaimable, `queued`/`processed` claims stay terminal, and non-duplicate insert failures throw for provider retry. Use the ORDER-006 checks to prove storefront order creation rejects bogus shipping methods and derives shipping from active backend methods. Use the ORDER-007 checks to prove same-status retries repair inventory across admin status changes, fulfillment, COD, delivery webhook/refresh, admin full edits, refunds, and returns while fulfilled refunds do not auto-restock deducted inventory. Use the ORDER-008 checks to prove provider shipment creation owns an order-level shipment claim, active claims block admin/order/refund/payment-session mutations and shipment refresh, queue/webhook paths retry instead of skipping, provider failures clear claims, and provider success plus final local CAS failure leaves reconciliation-required state without inventory side effects. Use the ORDER-009 checks to prove admin full order edits reject failed negative inventory deltas before item replacement, preserve old item context when item replacement fails, compensate pre-write inventory on later write failures, and treat delivered as a stock-deducting status consistently with the central inventory transition helper. Use checkout-attempt/order-ingest retirement checks to prove storefront order creation remains synchronous, same-key retries replay or return duplicate in-flight `202`, stale claims converge on existing committed orders, and reservation failures release stock or return buyer-safe cart issues. Use the ORDER-005 checks to prove abandoned-checkout cleanup releases reserved inventory before archiving, does not hard-delete orders, and leaves orders/items retryable when release fails.

## Local Dev Commands

```bash
pnpm dev
pnpm dev:all
pnpm dev:api
pnpm dev:admin
pnpm dev:storefront
pnpm dev:setup
pnpm dev:reset
pnpm dev:admin:create
pnpm dev:admin:reset
pnpm dev:admin:status
pnpm dev:doctor
pnpm dev:doctor:api
pnpm dev:doctor:admin
pnpm dev:doctor:storefront
pnpm dev:doctor:all
```

Expected ports:

- API: `http://localhost:8787`
- Admin: `http://localhost:4323/admin`
- Storefront: `http://localhost:4322`
- Swagger UI: `http://localhost:8787/api/v1/docs`
- OpenAPI: `http://localhost:8787/api/v1/openapi.json`

Known local-dev risks:

- `dev:setup` and `dev:reset` create `admin@local.scalius.test` / `ScaliusLocal123!` by default. Override with `--admin-email`, `--admin-password`, `--admin-name`, or `LOCAL_ADMIN_*`.
- `dev:setup` reuses existing shared secrets when only some local `.dev.vars` files exist, and fails if existing API/admin/storefront shared secrets disagree. Use `pnpm dev:setup --env-only` for env-file repair without migrations/admin creation, and `pnpm dev:setup --force --env-only` when intentionally regenerating all local env files.
- API local dev uses `apps/api/wrangler.local.jsonc`, which omits the remote Workers AI binding so setup/admin/storefront can boot without a Cloudflare remote proxy session.
- Dev startup applies pending local D1 migrations before API starts unless `SCALIUS_SKIP_DEV_MIGRATIONS=1`. `pnpm dev:api`, `pnpm dev:admin`, `pnpm dev:storefront`, and `pnpm dev` run through the wrapper; combined modes wait for API `/api/v1/setup` before starting dependent apps.
- Astro 7 storefront dev may run as a background server in non-interactive agent sessions. `scripts/dev.sh` should stream `astro dev logs --follow` after background startup and stop it with `astro dev stop` during cleanup. For Astro-only debugging, use `astro dev --background`, `astro dev status`, `astro dev logs`, and `astro dev stop`; for functional storefront pages, keep the API worker running too.
- Dev helpers resolve pnpm through the current Corepack/pnpm shim instead of requiring `pnpm` on PATH. Regress this with a PATH that includes Node but not pnpm, then run `node scripts/deploy.mjs --migrate-only --local`.
- `pnpm dev:doctor` is non-mutating. Plain mode reports missing env/state, non-local or wrong-port local URL values, and warns when servers are not running. Use the matching profile shortcut after startup: `pnpm dev:doctor:api`, `pnpm dev:doctor:admin`, `pnpm dev:doctor:storefront`, or `pnpm dev:doctor:all`.
- Use `SCALIUS_WRANGLER_STATE=/tmp/scalius-commerce-state` or `--state /tmp/scalius-commerce-state` to test setup/reset/dev against disposable local state without touching the default `.wrangler/state`. Script `--state` values are normalized from the repo root; prefer absolute paths in audit notes.
- Admin production uses `env.API`; local dev should hit HTTP fallback whenever `PUBLIC_API_BASE_URL` points at localhost. `pnpm dev:doctor` fails local env URL values that point at production domains or the wrong ports. Verify both server functions and `/api/v1/admin/*` browser proxy routes after transport changes.
- Unauthenticated `/admin` should server-redirect before rendering HTML: `curl -i http://localhost:4323/admin` should return `307` with `location: /auth/login`. Authenticated browser login should render the dashboard without Better Auth session-schema errors.
- `scripts/dev.sh` kills only Scalius dev ports by default. Set `SCALIUS_DEV_KILL_ALL_WORKERD=1` only when aggressive cleanup is needed.

Local helper regression checks:

```bash
bash -n scripts/dev.sh
node --check scripts/dev-local-utils.mjs
node --check scripts/dev-admin.mjs
node --check scripts/dev-setup.mjs
node --check scripts/dev-reset.mjs
node --check scripts/dev-doctor.mjs
pnpm exec vitest run scripts/dev-admin-cli.test.mjs scripts/dev-local-utils.test.mjs scripts/dev-doctor.test.mjs scripts/dev-sh.test.mjs --passWithNoTests
pnpm dev:doctor
pnpm dev:doctor --profile api
```

Expected result:

- Valueless flags such as `--password`, `--state`, or `--admin-password` fail before side effects.
- `dev:admin:reset` proves API reachability before clearing local auth tables.
- `dev:setup --env-only` repairs missing or blank runtime and build-time env keys without migrations/admin creation.
- `scripts/dev.sh` preserves the failing child process exit code after cleanup.
- `scripts/dev.sh` has a dry-run regression proving API-only startup and API-readiness ordering before admin/storefront startup.
- `dev:doctor --profile api|admin|storefront|all` checks only the services expected for that local stack, so intentional partial stacks do not create false service warnings/failures.

Disposable reset smoke test:

```bash
rm -rf /tmp/scalius-commerce-state
pnpm dev:reset --state /tmp/scalius-commerce-state \
  --admin-email disposable@local.test \
  --admin-password 'Disposable123!' \
  --admin-name 'Disposable Admin'

SCALIUS_WRANGLER_STATE=/tmp/scalius-commerce-state pnpm dev:admin
SCALIUS_WRANGLER_STATE=/tmp/scalius-commerce-state pnpm dev:doctor:admin
```

Expected result:

- All D1 migrations apply to the disposable path.
- `/api/v1/setup` creates the admin.
- If setup previously inserted a Better Auth user but failed before admin promotion, rerunning `pnpm dev:admin:create` should recover the partial first-admin state instead of returning a 500.
- Browser login at `http://localhost:4323/auth/login` reaches `/admin`.
- API worker logs show `GET /api/v1/admin/dashboard/summary 200 OK` and `GET /api/v1/admin/dashboard/activity 200 OK`; the legacy `GET /api/v1/admin/dashboard` endpoint should remain available for compatibility.
- The admin proxy route can be checked with a cookie jar; `GET http://localhost:4323/api/v1/admin/dashboard` should return `200 OK` and `x-proxy-base-url: http://localhost:8787/api/v1`.
- Admin order detail should render without a payment-card waterfall: visit an order detail page such as `http://localhost:4323/admin/orders/{id}` and confirm the initial route load warms `/orders/{id}/payments`; COD orders should also warm `/orders/{id}/cod`. Optional delivery-provider/payment/COD/currency warmup failures should log a warning and keep the order detail page loadable.
- Admin checkout settings should render the checkout-flow tab after preloading only auth settings; payment gateway and shipping method API calls should not happen until their tabs are opened.

Local post-sale mutation smoke:

```bash
rm -rf /tmp/scalius-commerce-ops006-state
node scripts/dev-postsale.mjs checkout-smoke --state /tmp/scalius-commerce-ops006-state
node scripts/dev-postsale.mjs load --state /tmp/scalius-commerce-ops006-state --skip-migrations --orders 10 --concurrency 3
node scripts/dev-postsale.mjs otp-smoke --state /tmp/scalius-commerce-ops006-state --skip-migrations
node scripts/dev-postsale.mjs payment-readiness --state /tmp/scalius-commerce-ops006-state --skip-migrations
```

Expected result:

- The helper refuses production and non-local API targets before creating any orders, support requests, OTP sends, or fixture rows.
- `checkout-smoke` seeds one active shipping method, one active city/zone/area, COD settings, email notification settings, and one published SKU-backed product, then validates cart state, creates a COD order, replays the same checkout request id, fetches the receipt, and submits one support request.
- `load` creates only disposable local COD orders and reports `201` counts plus min/p50/p95/max/avg latency. Start with `--orders 10 --concurrency 3`; raise the numbers only when investigating measured local bottlenecks.
- `otp-smoke` passes when a local delivery provider is configured, or when the runtime fails closed with `503` and leaves no pending OTP challenge for dummy/unconfigured delivery.
- `payment-readiness` seeds committed local Stripe, SSLCommerz, and Polar orders with receipt-token proof, clears local gateway credentials, and expects each payment-session endpoint to fail closed with `503` before writing `payment_plans` or `payment_session_attempts`. It must not contact external providers.

Production and staging mutation policy:

- Production/live smokes are read-only only: health, readyz, checkout config, OpenAPI shape, protected-route redirects, and consented receipt-token reads. Do not create disposable production orders, support requests, OTP sends, payment sessions, provider webhooks, refunds, or delivery shipments.
- Mutating staging smokes require an explicit test-store origin, sandbox payment/delivery/notification credentials, isolated customer identifiers, and a fresh confirmation in the tool that is about to mutate. The local `dev-postsale` helper intentionally does not implement staging mutation yet.

## Turbo And Deploy Checks

Inspect the actual task graph before trusting root scripts:

```bash
node --check scripts/deploy.mjs
pnpm check:dist-secrets
pnpm run deploy:api -- --dry-run
pnpm exec turbo run build --dry=json
pnpm exec turbo run lint --filter='!@scalius/tsconfig' --dry=json
pnpm exec turbo run deploy --filter=@scalius/api --dry=json
pnpm exec turbo run deploy --filter=@scalius/admin-v2 --dry=json
pnpm exec turbo run deploy --filter=@scalius/storefront --dry=json
```

Verify Turbo's global cache inputs for env-sensitive builds:

```bash
pnpm exec vitest run scripts/turbo-config.test.mjs
PUBLIC_API_URL=https://api.example.test/api/v1 \
PUBLIC_API_BASE_URL=https://api.example.test \
STOREFRONT_URL=https://storefront.example.test \
CDN_DOMAIN_URL=cdn.example.test \
R2_PUBLIC_URL=https://cdn.example.test \
VITE_FIREBASE_API_KEY=test-key \
pnpm exec turbo run build --dry=json \
  --filter=@scalius/admin-v2 \
  --filter=@scalius/storefront \
  --filter=@scalius/api > /tmp/scalius-turbo-build-dry-env.json
node - <<'NODE'
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync("/tmp/scalius-turbo-build-dry-env.json", "utf8"));
const files = Object.keys(data.globalCacheInputs.files);
const specified = data.globalCacheInputs.environmentVariables.specified.env;
const configured = data.globalCacheInputs.environmentVariables.configured;
for (const required of [
  "apps/api/.dev.vars",
  "apps/admin-v2/.dev.vars",
  "apps/storefront/.dev.vars",
  "PUBLIC_API_URL",
  "PUBLIC_API_BASE_URL",
  "STOREFRONT_URL",
  "CDN_DOMAIN_URL",
  "R2_PUBLIC_URL",
  "VITE_FIREBASE_API_KEY",
]) {
  const present = required.includes("/") ? files.includes(required) : specified.includes(required);
  if (!present) throw new Error(`Missing Turbo cache input: ${required}`);
  if (!required.includes("/") && !configured.some((entry) => entry.startsWith(`${required}=`))) {
    throw new Error(`Missing Turbo configured env hash: ${required}`);
  }
}
NODE
```

Use these checks to verify:

- Deploy targets include typecheck and migration gates where required.
- Lint tasks actually exist for the seven code workspaces; `@scalius/tsconfig` is intentionally filtered from root lint.
- Build inputs include relevant `src/**`, `public/**`, scripts, configs, and generated asset inputs.
- Build global cache inputs include app-local env files and declared build-time env names.
- Build outputs exclude local env files such as `.dev.vars`, `.env*`, and `*.vars`.
- Storefront build cache does not preserve stale build IDs.
- Root and package-local deploy scripts route through `scripts/deploy.mjs --only ...` and keep typecheck, dist-secret checks, and migration gates. Use `pnpm run deploy*` from the root so pnpm does not route to its built-in `deploy` command.
- Deploy dry runs validate typecheck/build/dist output but do not apply D1 migrations or deploy Workers.
- `scripts/copy-flags.mjs` fails if `country-flag-icons` or required copied flags are missing.

## Generated Contract Checks

OpenAPI/SDK:

```bash
pnpm view @hey-api/openapi-ts version engines peerDependencies dependencies --json
pnpm view @hey-api/client-fetch version deprecated --json
pnpm generate:sdk
pnpm --filter @scalius/api-client typecheck
pnpm --filter @scalius/admin-v2 typecheck
pnpm --filter @scalius/storefront typecheck
! rg -n '@hey-api/client-fetch|src/generated/client-core|scripts/post-generate|generated/client-core|\./client-core' \
  packages/api-client/package.json \
  packages/api-client/src \
  packages/api-client/scripts \
  pnpm-lock.yaml
git diff --exit-code packages/api-client/openapi.json packages/api-client/src/generated
```

The `@hey-api/client-fetch` plugin name should remain only in `packages/api-client/openapi-ts.config.ts`/docs as a bundled generator plugin, not as a package dependency or generated runtime shim.

Database:

```bash
pnpm db:generate
git diff -- packages/database/migrations packages/database/src/schema
```

Cloudflare bindings:

```bash
pnpm check:env
pnpm --filter @scalius/api exec wrangler types
pnpm --filter @scalius/admin-v2 exec wrangler types
pnpm --filter @scalius/storefront exec wrangler types
```

Use `pnpm check:env` as the routine drift guard. Use generated Wrangler output only when intentionally replacing or refreshing type declaration files. Do not hand-edit generated SDK files.

## Security And Privacy Verification

2FA API boundary:

1. Create or use an admin with 2FA enabled.
2. Start a session that has not completed 2FA.
3. Call an admin API route directly.
4. Expected current verified behavior: API rejects the request until 2FA is verified.
5. Method-change regression: submit `/api/v1/admin/auth/2fa/method` with an invalid target-method code and verify the preferred method is not changed.
6. Session-rotation regression: password change and first-time TOTP setup must preserve the replacement Better Auth cookie on the dashboard domain; the JSON response must not expose the replacement token.
7. Current trusted-device policy regression: `POST /api/v1/admin/auth/2fa/verify` and direct same-origin Better Auth verification paths with `trustDevice: true` should return 400 and should not call Better Auth verification.
8. Before changing trusted-device behavior, open or reopen a tracker item and prove TOTP-preferred login, email-preferred login, backup-code login, stale trusted-device cookies, and post-login admin API access in a browser.

Scanner RBAC:

1. Log in as an admin without inventory stock permissions.
2. `POST /api/scanner-token`.
3. Exchange the token for scanner session.
4. Attempt `POST /api/v1/admin/inventory/stock-adjust`.
5. Expected current verified behavior: token minting or scanner mutation is denied.

Public order receipt:

1. Create an order and capture both `orderId` and the same-origin receipt cookie set by the storefront checkout proxy.
2. Open `http://localhost:4322/order-success?orderId=<id>` in a private browser with no cookies.
3. Expected: storefront redirects away from the receipt page and no order PII is rendered.
4. Open `http://localhost:4322/order-success?orderId=<id>&token=<old-proof>`.
5. Expected: the URL proof is ignored/removed, the receipt still fails closed without the cookie, and no order PII is rendered.
6. Open `http://localhost:4322/order-success?orderId=<id>` with the receipt cookie from checkout.
7. Expected: minimal receipt renders, but phone, email, customer ID, shipments, delivery provider objects, raw receipt proof, and notes are absent.
8. Call `GET /api/v1/orders/receipt/<id>?token=wrong`.
9. Expected: `401`/`404`; query proof must not be accepted and must not reach the order lookup path. Valid proof uses `X-Receipt-Token` or same-origin proxy body/header forwarding only.

Checkout DOM injection:

1. Before visiting `/checkout`, set checkout session data with a customer name such as `<img src=x onerror=alert(1)>`.
2. Load checkout.
3. Expected current verified behavior: the string renders as text or is rejected.

Public checkout-language mutations:

```bash
curl -i -X POST http://localhost:8787/api/v1/checkout-languages \
  -H 'Content-Type: application/json' \
  --data '{"name":"Test","code":"xx"}'
```

Expected current verified behavior: public mutation returns 401/403/404/405, while admin-authenticated mutation still works through the admin route.

## Order, Inventory, Payment, Delivery Verification

For every order-state fix, create tests that assert both success and failure ordering:

- CAS conflict after provider success.
- Provider failure after local claim.
- Inventory transition success followed by shipment/order batch failure.
- Duplicate webhook delivery.
- Queue redelivery of one failed message in a mixed batch.
- Full refund with payment, order status, inventory, and notification expectations.
- Soft-delete restore of terminal/restored/deducted orders cannot produce impossible status/inventory pairs such as `delivered + reserved` or `cancelled + reserved`.
- Shipment deletion cannot remove a `reconcile_required` or order-claimed shipment row while an order-level shipment claim remains active.

Suggested focused commands:

```bash
pnpm --filter @scalius/core test -- src/modules/orders/orders.fulfillment.test.ts
pnpm --filter @scalius/core test -- src/modules/orders/orders.ingest.test.ts src/modules/orders/orders.storefront.test.ts
pnpm --filter @scalius/core test -- src/modules/inventory/release.test.ts
pnpm --filter @scalius/core test -- src/modules/inventory/expiry.test.ts
pnpm --filter @scalius/core test -- src/modules/payments/process-payment.test.ts
pnpm --filter @scalius/core test -- src/modules/payments/polar.test.ts
pnpm --filter @scalius/core test -- src/modules/delivery/tracking.test.ts
pnpm --filter @scalius/api test -- src/routes/webhooks/stripe.test.ts src/routes/webhooks/sslcommerz.test.ts
pnpm --filter @scalius/api test -- src/routes/webhooks/steadfast.test.ts
pnpm --filter @scalius/api test -- src/utils/cache-invalidation.test.ts
pnpm --filter @scalius/storefront exec vitest run src/lib/cache-purge-policy.test.ts --passWithNoTests
pnpm --filter @scalius/storefront typecheck
```

## Storefront Verification

Use browser checks after storefront changes:

- Cart form still submits with guest and logged-in customer.
- Location dropdowns prefill saved city/zone.
- Checkout supports COD and at least one redirect gateway without losing recoverability.
- Customer auth proxy sets cookies on the storefront domain.
- Search/config browser calls do not hit a missing `/api/v1/**` storefront route.
- `sitemap-static.xml` excludes cart/checkout/account/private pages.
- Future `publishedAt` pages are not visible and not in sitemap.
- Cache purge changes are visible after L1 clear and Cache API/L2 behavior is tested under Wrangler or deployed Worker runtime.
- Required storefront SSR data failures do not become cacheable empty pages: `/`, `/search`, and `/categories/{slug}` should use the non-cacheable temporary-unavailable path when required data is missing, while product sitemap/feed routes return `503 no-store` on `getAllProducts() === null` or partial paginated product-read failures.

Useful commands:

```bash
curl -i 'http://localhost:4322/api/v1/search?q=test'
curl -s http://localhost:4322/sitemap-static.xml | rg '/cart|/checkout|/account'
curl -s http://localhost:4322/cart | rg -i 'noindex|robots'
pnpm --filter @scalius/storefront exec vitest run src/lib/storefront-unavailable-response.test.ts src/lib/api/products.test.ts src/lib/page-data-boundaries.test.ts src/lib/route-tests/sitemap-products.test.ts src/lib/route-tests/sitemap-index.test.ts src/lib/route-tests/api/facebook-feed.test.ts --passWithNoTests
```

## Hard-To-Run Areas

These need Wrangler, provider sandboxes, or deployed Worker verification:

- Cloudflare service bindings between admin/storefront and API.
- Cache API L2 invalidation across isolates.
- Queues and retry behavior.
- Cron reservation expiry.
- Stripe, SSLCommerz, Polar, Pathao, Steadfast webhooks.
- OTP delivery over email/SMS/WhatsApp.
- Production cookie domain behavior.

When local verification is blocked, write a focused unit or route test first, then document the remaining deployed-runtime check in the tracker.

## Reporting Template

```md
Verification:
- Commands run:
- Manual flows run:
- Passed:
- Failed:
- Blocked:
- Follow-up tracker IDs:
```
