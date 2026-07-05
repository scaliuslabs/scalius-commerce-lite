# PERF-003 Tiptap Media Trigger Ownership

Date: 2026-07-05

## Finding

`TiptapMenuBar` used a page-global hidden wrapper id plus `document.getElementById(...).querySelector("button")?.click()` to open the media manager. When multiple rich-text editors were mounted, the second editor's Media Library button could trigger the first editor's hidden media manager and route selected images into the wrong editor.

This is reachable anywhere product rich content can mount multiple editors, especially expanded additional sections.

## Implemented Slice

- Removed the hidden global media-manager wrapper and page-wide DOM lookup from `TiptapMenuBar`.
- Rendered `MediaManager` with its existing `trigger` prop so each toolbar owns its own Media Library trigger.
- Updated `ToolbarButton` to forward React click events, which keeps cloned trigger behavior compatible with `LazyMediaManager`.
- Added a component regression test that renders two menu bars, clicks the second media trigger, and asserts only the second editor receives `setImage`.
- Extended route-graph guards so the old wrapper id and query-selector bridge cannot be reintroduced silently.

## Verification

- `pnpm exec vitest run apps/admin-v2/src/components/ui/tiptap/TiptapMenuBar.test.tsx apps/admin-v2/src/components/ui/tiptap/ToolbarButton.test.tsx apps/admin-v2/src/lib/route-graph-boundaries.test.ts` passed (`3` files / `49` tests).
- `pnpm --filter @scalius/admin-v2 typecheck` passed.
- `pnpm --filter @scalius/admin-v2 lint` passed.
- `pnpm --filter @scalius/admin-v2 build` passed.
- Local admin browser smoke opened `/admin/products/ops006_product/edit`, clicked the description Media Library trigger, confirmed the media dialog opened from that toolbar, opened the Additional Sections tab, and captured zero browser warnings/errors.
- Admin deploy completed at version `70cbb18d-6527-44b3-b048-93b74185fcc4`.
- Live unauthenticated product edit redirected to `/auth/login`; demo sign-in through `POST /api/auth/sign-in/email` returned `200` with session cookies; authenticated product edit returned `200` with title `Edit Product | Scalius Admin`.
- Source/dist/deployed-asset scans found no old global trigger wrapper or `querySelector("button")?.click()` bridge in the rich-editor assets. `ProductForm` still contains an unrelated `document.getElementById`, so future checks should prefer the exact wrapper/bridge markers.

## Follow-Up

- A product with two saved expanded additional rich-text sections would be a stronger manual smoke fixture. The component regression already covers the ownership bug directly without saving local or production product content.
