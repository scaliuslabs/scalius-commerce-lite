# Widgets

Custom HTML/CSS widgets displayed on the homepage, positioned relative to collections or at fixed locations.

## Exports

- `listWidgets()` — all active widgets with available collections for placement reference
- `getWidgetById()` — single widget lookup
- `createWidget()` / `updateWidget()` / `deleteWidget()` — admin mutations
- `bulkDeleteWidgets()` / `bulkActivateWidgets()` / `bulkDeactivateWidgets()` / `restoreWidgets()` — bulk ops
- `createWidgetSchema` / `updateWidgetSchema` — Zod validation with placement rule constraints
- `CreateWidgetInput` / `UpdateWidgetInput` — TypeScript types

## Dependencies

- `@scalius/database` — `widgets`, `collections` tables

## API Routes

- `GET /api/v1/widgets` — list widgets (admin)
- `POST /api/v1/widgets` — create widget
- `PUT /api/v1/widgets/:id` — update widget
- `DELETE /api/v1/widgets/:id` — soft-delete widget
