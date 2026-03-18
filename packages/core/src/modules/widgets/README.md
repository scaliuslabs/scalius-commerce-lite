# Widgets

Custom HTML/CSS content blocks rendered on the storefront homepage, positioned relative to collections or at fixed locations. Widgets support AI-assisted generation, version history, and shortcode embedding in CMS pages.

## Placement System

Widgets are placed on the homepage via `placementRule`:

| Rule | Behavior |
|------|----------|
| `before_collection` | Rendered immediately before a specific collection (requires `referenceCollectionId`) |
| `after_collection` | Rendered immediately after a specific collection (requires `referenceCollectionId`) |
| `fixed_top_homepage` | Rendered at the very top of the homepage, above the hero |
| `fixed_bottom_homepage` | Rendered at the very bottom of the homepage, below all collections |
| `standalone` | Not auto-rendered on the homepage. Embeddable in CMS pages via shortcode `[widget id="wid_xxx"]` |

Widgets with `before_collection` or `after_collection` require a valid `referenceCollectionId`. This is enforced by the Zod schema's `.refine()` rule and the admin form UI (which conditionally shows a collection selector).

Sorting within the same placement group is by `sortOrder` (ascending), then `name` (ascending).

## Version History

Widget content changes can be tracked via the `widgetHistory` table:

- **Save version** (`createHistoryEntry`): Snapshots the widget's current `htmlContent` and `cssContent` with a reason string (default: "Manual save").
- **Restore version** (`restoreFromHistory`): Before overwriting the widget, auto-snapshots the current state with reason "Auto-saved before restore", then applies the selected history entry's HTML/CSS.
- **Delete version** (`deleteHistoryEntry`): Permanently removes a single history entry.
- **List history** (`getWidgetHistory`): Returns all entries for a widget, ordered by `createdAt DESC`.
- History entries cascade-delete when the parent widget is permanently deleted (FK `onDelete: cascade`).

## AI Context Persistence

Each widget has an `aiContext` text column storing a JSON blob (via `@scalius/core/modules/ai/ai-context-schema`). On form save, the admin persists:

- `promptType` (widget / landing-page / collection)
- `preferredAiModel` (OpenRouter model ID)
- `useStagedMode` (boolean)
- `savedImages`, `savedProducts`, `savedCategories`, `allCategoriesSelected`
- `stagedPlan` and `stagedSections` (section breakdown from staged generation)
- `improvementHistory` (array of `{ section?, prompt, timestamp, modelUsed }`)
- `createdAt` (timestamp of initial AI context creation)

This context is loaded back into the form on edit, restoring the full AI assistant state.

## Widget Shortcodes

Standalone widgets can be embedded in CMS page content via shortcodes:

```
[widget id="wid_xxx"]
```

The storefront's `processShortcodes()` in `apps/storefront/src/lib/shortcodes.ts` parses these, calls `getWidgetById()` from the public API, and injects the widget's HTML/CSS inline (wrapped in a `<div class="widget-shortcode not-prose">`). Inactive or missing widgets render an error placeholder.

## Files

- `index.ts` -- barrel exports (re-exports everything from `widgets.service.ts`)
- `widgets.service.ts` -- all DB queries and mutations
- `widgets.validation.ts` -- Zod schemas (`createWidgetSchema`, `updateWidgetSchema`)

### Service Functions

**Queries:**
- `listWidgets(db)` -- returns all non-deleted widgets (sorted by `sortOrder`, `name`) plus all active collections (for the placement selector)
- `getWidgetById(db, id)` -- single widget by ID (non-deleted only)

**Mutations:**
- `createWidget(db, data)` -- inserts with `wid_` prefixed nanoid; serializes `aiContext` to JSON
- `updateWidget(db, id, data)` -- partial update; throws `NotFoundError` if missing
- `deleteWidget(db, id)` -- soft-delete (sets `deletedAt`)
- `bulkDeleteWidgets(db, ids, permanent?)` -- soft or hard delete
- `bulkActivateWidgets(db, ids)` / `bulkDeactivateWidgets(db, ids)` -- toggle `isActive`
- `restoreWidgets(db, ids)` -- clears `deletedAt`

**History:**
- `createHistoryEntry(db, widgetId, reason?)` -- snapshots current widget content
- `getWidgetHistory(db, widgetId)` -- lists all history entries (newest first)
- `restoreFromHistory(db, widgetId, historyId)` -- auto-saves current state, then overwrites widget with history entry
- `deleteHistoryEntry(db, widgetId, historyId)` -- removes a single history entry

## API Endpoints

### Admin (authenticated, via `apps/api/src/routes/admin/widgets.ts`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/widgets` | List all widgets + available collections |
| POST | `/admin/widgets` | Create widget |
| GET | `/admin/widgets/{id}` | Get widget by ID |
| PUT | `/admin/widgets/{id}` | Update widget |
| DELETE | `/admin/widgets/{id}` | Soft-delete widget |
| DELETE | `/admin/widgets/{id}/permanent` | Hard-delete widget |
| POST | `/admin/widgets/{id}/restore` | Restore soft-deleted widget |
| PATCH | `/admin/widgets/{id}/toggle-status` | Toggle `isActive` |
| POST | `/admin/widgets/bulk-delete` | Bulk soft/hard delete |
| POST | `/admin/widgets/bulk-activate` | Bulk activate |
| POST | `/admin/widgets/bulk-deactivate` | Bulk deactivate |
| POST | `/admin/widgets/bulk-restore` | Bulk restore |
| GET | `/admin/widgets/{id}/history` | List widget version history |
| POST | `/admin/widgets/{id}/history` | Save current state as history entry |
| POST | `/admin/widgets/{id}/history/restore` | Restore widget from history version |
| DELETE | `/admin/widgets/{id}/history/{versionId}` | Delete a history entry |

### Public (via `apps/api/src/routes/widgets.ts`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/widgets/active/homepage` | All active homepage widgets (cached 1h) |
| GET | `/widgets/{id}` | Single active widget by ID (cached 1h) |

Public routes convert timestamps to ISO strings and wrap in `{ widget }` / `{ widgets }`.

## Dependencies

- `@scalius/database` -- `widgets`, `widgetHistory`, `collections` tables
- `@scalius/core/errors` -- `NotFoundError`
- `nanoid` -- ID generation

## Known Gaps

- **Trash listing**: The admin `listWidgets` service always filters `deletedAt IS NULL`. The trash view calls the same endpoint. The loader (`apps/admin/src/loaders/admin/widgets.ts`) passes a `trashed` param, but the service function ignores it -- the trash page currently shows widgets fetched with the same `isNull(deletedAt)` filter. This means the trash view may not actually display trashed widgets unless the API endpoint handles the `trashed` query parameter (which it does not -- the admin list route has no query params at all).
- **Widget shortcode in [slug].astro**: The `[slug].astro` page references `page.widgets` (an optional array on the storefront's `Page` type), but the public pages API does not return a `widgets` field. The shortcode system works through `processShortcodes()` which parses `[widget id="..."]` from the content string -- the `page.widgets` array rendering path appears to be dead code or intended for future widget-page associations.
- **Public route uses raw `db` import**: The public pages route (`apps/api/src/routes/pages.ts`) imports `db` directly from `@scalius/database/client` instead of using `c.get("db")` from Hono context, inconsistent with the admin routes.
- **No search on widget list**: The admin widget list does client-side name filtering only (no FTS5 integration, unlike pages).
- **displayTarget**: The schema has `displayTarget` with only `"homepage"` as an enum value. Changing this in the future would require a schema migration.
