# Widgets

Custom HTML/CSS content blocks rendered on the storefront homepage, positioned relative to collections or at fixed locations. Widgets support AI-assisted generation, version history, HTML sanitization, and shortcode embedding in CMS pages.

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

## HTML Sanitization

The `sanitizeWidgetHtml()` function strips dangerous HTML patterns from widget content before serving to the storefront:

1. Removes `<script>` tags and their contents
2. Removes inline event handlers (`onclick`, `onerror`, etc.)
3. Replaces `javascript:` protocol URLs with `blocked:`

Applied by `getActiveWidgetById()` and `getActiveHomepageWidgets()` -- the public-facing query functions.

## Trash / Soft Delete

The `listWidgets` service accepts `{ showTrashed?: boolean }`. When `showTrashed` is true, it returns widgets where `deletedAt IS NOT NULL`. When false (default), it returns widgets where `deletedAt IS NULL`. The admin API list route passes the `trashed` query parameter through to the service, so the trash view (`?trashed=true`) correctly shows only soft-deleted widgets.

Individual and bulk operations:
- `deleteWidget(db, id)` -- soft-delete (sets `deletedAt`)
- `bulkDeleteWidgets(db, ids, permanent?)` -- soft delete by default; permanent=true does hard delete
- `restoreWidgets(db, ids)` -- clears `deletedAt`

## Version History

Widget content changes can be tracked via the `widgetHistory` table:

- **Save version** (`createHistoryEntry`): Snapshots the widget's persisted `htmlContent` and `cssContent` by default, or explicit draft HTML/CSS from the editor when supplied, with a reason string (default: "Manual save").
- **Restore version** (`restoreFromHistory`): Atomic via `db.batch()` -- auto-snapshots the current state with reason "Auto-saved before restore", then applies the selected history entry's HTML/CSS. Both operations execute in a single batch.
- **Delete version** (`deleteHistoryEntry`): Permanently removes a single history entry. Validates the entry belongs to the specified widget.
- **List history** (`getWidgetHistory`): Returns all entries for a widget, ordered by `createdAt DESC`. Throws `NotFoundError` if widget not found.
- History entries cascade-delete when the parent widget is permanently deleted (FK `onDelete: cascade`).

## AI Context Persistence

Each widget has an `aiContext` text column storing a JSON blob (via `@scalius/core/modules/ai/ai-context-schema`). On form save, the admin persists:

- `promptType` (widget / landing-page / collection)
- `preferredAiModel` (OpenRouter model ID)
- `savedImages`, `savedProducts`, `savedCategories`, `allCategoriesSelected`
- `stagedPlan` and `stagedSections` (accepted section metadata used by the editor)
- `improvementHistory` (array of `{ section?, prompt, timestamp, modelUsed }`)
- `createdAt` (timestamp of initial AI context creation)

This context is loaded back into the form on edit, restoring the full AI assistant state. The service serializes `aiContext` to JSON on save and stores it as text.

## Widget Shortcodes

Standalone widgets can be embedded in CMS page content via shortcodes:

```
[widget id="wid_xxx"]
```

The storefront's `processShortcodes()` in `apps/storefront/src/lib/shortcodes.ts` parses these, calls `getWidgetById()` from the public API, and injects the widget's HTML/CSS inline (wrapped in a `<div class="widget-shortcode not-prose">`). Inactive or missing widgets render an error placeholder.

## Files

- `index.ts` -- barrel exports (re-exports everything from `widgets.service.ts` and `widgets.validation.ts`)
- `widgets.service.ts` -- all DB queries, mutations, and history operations
- `widgets.validation.ts` -- Zod schemas (`createWidgetSchema`, `updateWidgetSchema`)

### Validation Schemas

From `widgets.validation.ts`:

- `widgetBaseSchema` -- base shape without `.refine()` so `.partial()` works for the update schema
- `createWidgetSchema` -- `widgetBaseSchema.refine(validateCollectionRef)` -- validates collection-based placements have a `referenceCollectionId`
- `updateWidgetSchema` -- `widgetBaseSchema.partial().refine(validateCollectionRef)`
- `aiContext` field uses `z.record(z.string(), z.unknown()).nullable().optional()` -- accepts arbitrary JSON objects

Exported types: `CreateWidgetInput`, `UpdateWidgetInput`.

### Service Functions

**Queries:**
- `listWidgets(db, options?)` -- returns widgets filtered by `showTrashed` flag (non-deleted by default, only-deleted when trashed) sorted by `sortOrder`, `name`; also returns all active non-deleted collections for the placement selector
- `getWidgetById(db, id)` -- single widget by ID (non-deleted only)
- `getActiveWidgetById(db, id)` -- single active, non-deleted widget by ID with sanitized HTML for storefront rendering
- `getActiveHomepageWidgets(db)` -- all active homepage widgets with sanitized HTML, ordered by `placementRule`, `sortOrder`

**Mutations:**
- `createWidget(db, data)` -- inserts with `wid_` prefixed nanoid; serializes `aiContext` to JSON
- `updateWidget(db, id, data)` -- partial update; throws `NotFoundError` if missing; serializes `aiContext` to JSON
- `deleteWidget(db, id)` -- soft-delete (sets `deletedAt`)
- `bulkDeleteWidgets(db, ids, permanent?)` -- soft or hard delete
- `bulkActivateWidgets(db, ids)` / `bulkDeactivateWidgets(db, ids)` -- toggle `isActive`
- `restoreWidgets(db, ids)` -- clears `deletedAt`

**History:**
- `createHistoryEntry(db, widgetId, reason?)` -- snapshots current widget content
- `getWidgetHistory(db, widgetId)` -- lists all history entries (newest first); throws `NotFoundError` if widget not found
- `restoreFromHistory(db, widgetId, historyId)` -- atomic via `db.batch()`: auto-saves current state, then overwrites widget with history entry
- `deleteHistoryEntry(db, widgetId, historyId)` -- removes a single history entry; throws `NotFoundError` if entry not found

## API Endpoints

### Admin (authenticated, via `apps/api/src/routes/admin/widgets.ts`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/widgets` | List all widgets + available collections (`?trashed=true` for trash view) |
| POST | `/admin/widgets` | Create widget |
| GET | `/admin/widgets/{id}` | Get widget by ID |
| PUT | `/admin/widgets/{id}` | Update widget |
| DELETE | `/admin/widgets/{id}` | Soft-delete widget |
| DELETE | `/admin/widgets/{id}/permanent` | Hard-delete widget |
| POST | `/admin/widgets/{id}/restore` | Restore soft-deleted widget |
| PATCH | `/admin/widgets/{id}/toggle-status` | Toggle `isActive` |
| POST | `/admin/widgets/bulk-delete` | Bulk soft/hard delete (`{ ids, permanent }`) |
| POST | `/admin/widgets/bulk-activate` | Bulk activate (`{ ids }`) |
| POST | `/admin/widgets/bulk-deactivate` | Bulk deactivate (`{ ids }`) |
| POST | `/admin/widgets/bulk-restore` | Bulk restore (`{ ids }`) |
| GET | `/admin/widgets/{id}/history` | List widget version history |
| POST | `/admin/widgets/{id}/history` | Save persisted or supplied draft state as history entry (`{ reason?, htmlContent?, cssContent? }`) |
| POST | `/admin/widgets/{id}/history/restore` | Restore widget from history version (`{ historyId }`) |
| DELETE | `/admin/widgets/{id}/history/{versionId}` | Delete a history entry |

### Public (via `apps/api/src/routes/widgets.ts`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/widgets/active/homepage` | All active homepage widgets with sanitized HTML (cached 1h) |
| GET | `/widgets/{id}` | Single active widget by ID with sanitized HTML (cached 1h) |

Public routes convert timestamps to ISO strings and wrap in `{ widget }` / `{ widgets }`.

## Dependencies

- `@scalius/database` -- `widgets`, `widgetHistory`, `collections` tables, `WidgetPlacementRule` enum
- `@scalius/core/errors` -- `NotFoundError`
- `nanoid` -- ID generation
- `zod` -- validation schemas

## Known Gaps

- **No search on widget list**: The admin widget list does client-side name filtering only (no FTS5 integration, unlike pages).
- **displayTarget**: The schema has `displayTarget` with only `"homepage"` as an enum value. Changing this in the future would require a schema migration.
