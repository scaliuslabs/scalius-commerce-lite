# Widget Generation Verification Plan

Date: 2026-05-13

Scope: verify widget generation end to end after changes to staged generation. This is a runbook/checklist only; source code changes are out of scope.

## What To Verify

Widget generation crosses five surfaces:

- Admin editor: `apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx`, `useAiGenerator.ts`, `useStagedGeneration.ts`, `AiAssistant.tsx`.
- Admin/API generation: `POST /api/v1/admin/ai/generate-staged`, `POST /api/v1/admin/ai/generate`, model/settings endpoints.
- Widget persistence/history: `POST/PUT /api/v1/admin/widgets`, `POST /api/v1/admin/widgets/{id}/history`.
- Storefront rendering: homepage, CMS page, product, category, and collection placement zones.
- Cache invalidation: API KV prefixes plus storefront `/api/purge-cache` version bump and L1 prefix clearing.

The highest-risk path is staged generation accepting a model result, merging sections into one widget, saving it, purging caches, and seeing the new rendered widget on the storefront without stale HTML/CSS.

## Preflight

- Confirm the worktree before and after the run:
  ```bash
  git status --short
  ```
- Do not edit `.dev.vars` or `.env.development`.
- Make sure local DB is migrated:
  ```bash
  pnpm db:migrate:local
  ```
- Start the integrated local stack:
  ```bash
  pnpm dev
  ```
- Local URLs:
  - Admin: `http://localhost:4323/admin`
  - Storefront: `http://localhost:4322`
  - API docs: `http://localhost:8787/api/v1/docs`
  - OpenAPI JSON: `http://localhost:8787/api/v1/openapi.json`

## Automated Checks

Run the focused tests first:

```bash
pnpm exec vitest run \
  apps/admin-v2/src/components/admin/widgets/widget-form/ai-stream.test.ts \
  apps/admin-v2/src/components/admin/widgets/widget-form/ai-context-limits.test.ts \
  apps/admin-v2/src/components/admin/widgets/widget-form/ai-context-warnings.test.ts \
  packages/core/src/modules/widgets/widgets.validation.test.ts \
  packages/core/src/modules/ai/ai-settings.service.test.ts \
  apps/api/src/utils/cache-invalidation.test.ts
```

Then run broader safety checks:

```bash
pnpm typecheck
pnpm test
pnpm build
```

If generated SDK contracts changed, regenerate and re-run typecheck:

```bash
pnpm generate:sdk
pnpm typecheck
```

## Local API Checks

Use an authenticated admin browser session or a captured admin cookie/token. Verify:

- Widget AI settings:
  ```bash
  curl -i http://localhost:4323/api/v1/admin/settings/widget-ai
  ```
  Expected: `200`, `{ success: true, data: ... }`, masked provider credential status, no raw secrets.

- Model listing for the active provider:
  ```bash
  curl -i "http://localhost:4323/api/v1/admin/ai/models?provider=cloudflare"
  ```
  Expected: `200`, provider, default model, model list or configured fallback.

- Staged plan response:
  ```bash
  curl -i http://localhost:4323/api/v1/admin/ai/generate-staged \
    -H "Content-Type: application/json" \
    --data '{"provider":"cloudflare","stage":"plan","messages":[{"role":"user","content":"Create a compact homepage promo widget for jute bags. Return only the requested plan JSON."}]}'
  ```
  Expected: response envelope with `success: true`; `data.choices[0].message.content` parses as a staged plan when credentials/rate limits are valid.

- Staged section response:
  ```bash
  curl -i http://localhost:4323/api/v1/admin/ai/generate-staged \
    -H "Content-Type: application/json" \
    --data '{"provider":"cloudflare","stage":"generate","sectionIndex":0,"totalSections":2,"messages":[{"role":"user","content":"Generate section 1 of 2. Use <htmljs> and <css> tags for a jute bag storefront widget."}]}'
  ```
  Expected: response envelope with `choices[0].message.content` containing `<htmljs>` and `<css>` content, or a clear provider/rate-limit error.

Also check the public widget read APIs after saving an active widget:

```bash
curl -i http://localhost:8787/api/v1/widgets/active/homepage
curl -i "http://localhost:8787/api/v1/widgets/active/scope/page?scopeId=<PAGE_ID>"
curl -i http://localhost:8787/api/v1/widgets/<WIDGET_ID>
```

Expected: public endpoints return `{ success: true, data: { widgets: [...] } }` or `{ widget: ... }`. Active homepage and scoped widget endpoints should send `Cache-Control: no-store, max-age=0`.

## Admin Flow Checklist

In `http://localhost:4323/admin`:

- Open `General Settings > Widget AI`.
- Verify the active provider and default model load.
- Save a harmless non-secret setting, then reload and confirm it persisted.
- Open `Widgets`.
- Create a new widget named `Verification - staged generation`.
- Add a placement that matches the target visual test, preferably:
  - Scope: `page`
  - Target: the CMS page whose slug is `testing-page`
  - Slot: `top` or `before_content`
  - Active: enabled
- In the AI assistant:
  - Confirm staged mode is enabled by default unless settings explicitly disabled it.
  - Use a prompt that forces multiple sections, product/category context, and tight vertical rhythm.
  - Watch progress move through planning and section generation.
  - Verify cancellation stops the active run and does not later overwrite the editor.
  - Run again and accept generated content.
- Save the widget.
- Open widget history and create a manual snapshot.
- Edit the widget, save, restore a prior history entry, and confirm the storefront changes after cache purge.

Expected editor behavior:

- Generated preview opens while loading.
- Staged progress shows section count.
- On success, generated HTML is a combined `.widget-container` with section wrappers.
- CSS includes wrapper composition plus section-specific styles.
- The saved widget has non-empty HTML before publishing.
- No model output appears as raw markdown fences on the storefront.
- No `<script>` or event-handler JavaScript survives in rendered widget HTML.

## Storefront Flow Checklist

Verify the same saved widget renders through each affected placement type when applicable:

- Homepage:
  ```bash
  open http://localhost:4322/
  curl -s http://localhost:4322/ | rg "Verification|widget-container|cms-widget-frame"
  ```
- CMS testing page:
  ```bash
  open http://localhost:4322/testing-page
  curl -s http://localhost:4322/testing-page | rg "Verification|widget-container|cms-widget-frame"
  ```
- Product page:
  ```bash
  open http://localhost:4322/products/<product-slug>
  ```
- Category page:
  ```bash
  open http://localhost:4322/categories/<category-slug>
  ```
- Collection page:
  ```bash
  open http://localhost:4322/collections/<collection-id>
  ```

Expected storefront behavior:

- `WidgetPlacementZone.astro` renders only live placements matching `scope`, `scopeId`, `slot`, and optional `anchorId`.
- `WidgetBlock.astro` emits `.cms-widget-frame` plus a scoped class like `.sw-<widget-id>`.
- `prepareWidgetContent()` normalizes `<htmljs>`/`<css>` wrappers, sanitizes HTML/CSS, optimizes image URLs, and scopes CSS.
- Multiple widgets in the same slot sort by slot, anchor, placement sort order, name, then id.

## Visual And Browser Checks For `/testing-page`

Use the local browser or Chrome DevTools on `http://localhost:4322/testing-page`:

- Hard refresh after saving the widget.
- Check desktop width around `1440x900`.
- Check tablet width around `768x1024`.
- Check mobile width around `390x844`.
- Confirm:
  - The generated widget is visible in the expected slot.
  - No huge vertical gaps between staged sections.
  - Text does not overflow cards/buttons.
  - CTA links are visible and clickable.
  - Images load with non-zero `naturalWidth` and `naturalHeight`.
  - No broken images.
  - No horizontal page scroll.
  - Browser console has no uncaught errors, CSP violations from widget content, or hydration errors.
  - Styles from one widget do not leak into page header/footer/product cards.

Helpful console snippets:

```js
[...document.images].filter((img) => !img.complete || img.naturalWidth === 0).map((img) => img.src)
```

```js
document.documentElement.scrollWidth > document.documentElement.clientWidth
```

```js
[...document.querySelectorAll(".cms-widget-frame")].map((el) => ({
  className: el.className,
  rect: el.getBoundingClientRect().toJSON(),
  text: el.textContent?.slice(0, 120),
}))
```

## Cache Purge Checklist

Widget admin writes call `invalidateWidgetCaches()`, which invalidates these groups:

```text
homepage, pages, products, categories, collections
```

That should clear API KV prefixes including `api:widgets:single:`, `api:widgets:active-homepage:`, page/homepage API caches, and trigger storefront purge for prefixes including:

```text
global_homepage_widgets
widget_
page_render_
page_slug_
product_slug_
category_slug_
collection_by_id_
widgets_scope_
storefront_homepage_
```

Local/prod purge endpoint behavior:

```bash
curl -i -X POST "http://localhost:4322/api/purge-cache?token=$PURGE_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"groups":["homepage","pages","products","categories","collections"],"prefixes":["global_homepage_widgets","widget_","page_render_","widgets_scope_"],"bumpVersion":true}'
```

Expected:

- `200` with `success: true`.
- `details.htmlVersionBumped: true`.
- `details.prefixesCleared` is a number.
- `details.cacheWarmingStarted: true`.

After a widget save or restore:

- Immediately reload `/testing-page`.
- Confirm the new content appears without waiting for TTL expiry.
- Reload once more to check L1/L2 cached response stays current.
- If production appears stale, verify `PURGE_URL` and `PURGE_TOKEN` are configured on the API worker and storefront worker, and inspect API/storefront logs for `[Cache]` or `[SelectivePurge]`.

## Production Deployment Checks

After deployment:

```bash
pnpm deploy
```

Production smoke checks:

```bash
curl -I https://api.scalius.com/api/v1/openapi.json
curl -I https://storefront.scalius.com/testing-page
curl -s https://api.scalius.com/api/v1/widgets/active/homepage | jq .
```

Then use the production dashboard:

- Open `https://dashboard.scalius.com/admin`.
- Confirm `General Settings > Widget AI` shows the intended active provider/model.
- Generate and save a small test widget against `/testing-page`.
- Open `https://storefront.scalius.com/testing-page` in a fresh/private window.
- Confirm the generated widget appears, assets load, and console is clean.
- Restore or deactivate the test widget and confirm it disappears after purge.

## Risks To Watch

- Staged plan fallback can hide a provider plan-format failure; inspect logs if every run silently uses deterministic section counts.
- Section retry may produce visual inconsistency if later sections are generated after failed attempts with partial context.
- A cancelled generation must not race and overwrite accepted content from a later run.
- `generate-staged` still accepts client-supplied messages; prompt injection from catalog/context remains a risk until server-owned generation requests replace it.
- Provider credentials and `CREDENTIAL_ENCRYPTION_KEY` must be present in the worker runtime; missing config looks like generation failure even when UI code is fine.
- Rate limiting uses KV when available; repeated manual tests can produce false failures.
- Storefront page render data can serve cached widgets unless purge bumps the HTML/cache version.
- Scoped placements require `scopeId`; homepage placements must not include one.
- CSS must remain scoped by widget id; global selectors in generated CSS can still create visual regressions if the scoper misses edge cases.
- Generated images may point to remote URLs that are blocked, slow, or not optimized; check actual rendered dimensions.
- Production cache purge depends on matching `PURGE_TOKEN` across API and storefront workers.

## Pass Criteria

- Focused tests, `pnpm typecheck`, and `pnpm build` pass.
- Admin staged generation can plan, generate, preview, accept, save, snapshot, restore, and deactivate a widget.
- Public widget API responses preserve the standard `{ success: true, data: ... }` envelope.
- `/testing-page` renders the new widget locally and in production with no stale content after purge.
- Desktop/tablet/mobile browser checks show no broken images, horizontal overflow, console errors, or obvious layout gaps between staged sections.
