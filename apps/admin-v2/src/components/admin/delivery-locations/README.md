# Delivery Locations Admin UI

Admin interface for managing the city/zone/area location hierarchy used by delivery providers. Embedded within the checkout settings page.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports: `DeliveryLocationsContainer` (also aliased as `DeliveryLocationsManager`) |
| `DeliveryLocationsContainer.tsx` | Root component. Wires `useDeliveryLocations()` hook to child components. Contains tabs (Cities/Zones/Areas), search input, parent filter dropdown, action buttons. |
| `LocationsTable.tsx` | Data table with columns: checkbox, name, parent (if zone/area), status toggle, external IDs badges, edit/delete actions. Paginated with configurable page size (10/20/50/100). `LocationRow` is memoized. |
| `LocationFormDialog.tsx` | Dialog for creating/editing a location. Fields: name (required), parent selector (for zones/areas), active toggle. |
| `PathaoImportPanel.tsx` | Three sub-components: `PathaoImportButton` (only visible if active Pathao provider exists), `PathaoImportProgressBanner` (progress bar with stats), `PathaoImportConfirmDialog` (confirmation before starting) |
| `DeleteConfirmationDialogs.tsx` | Three dialogs: single delete, bulk delete (shows count), clean-all (permanent deletion warning) |
| `hooks/useDeliveryLocations.ts` | Central state hook. Manages: location data + pagination, form state, delete state, bulk selection, Pathao import lifecycle |

## Tab System

Three tabs with independent data loads:
- **Cities**: top-level, no parent filter
- **Zones**: parent filter = cities (loaded from API with `limit=500`)
- **Areas**: parent filter = zones (loaded from API with `limit=500`)

Tab change resets `selectedParent` and `searchQuery`.

## API Endpoints Used

| Action | Method | Endpoint |
|--------|--------|----------|
| List locations | GET | `/api/v1/admin/settings/delivery-locations?type={tab}&page={p}&limit={l}&parentId={id}&search={q}` |
| Load parents | GET | `/api/v1/admin/settings/delivery-locations?type={parentType}&limit=500` |
| Create | POST | `/api/v1/admin/settings/delivery-locations` |
| Update | PUT | `/api/v1/admin/settings/delivery-locations/{id}` |
| Delete (single) | DELETE | `/api/v1/admin/settings/delivery-locations/{id}` |
| Delete (bulk) | DELETE | `/api/v1/admin/settings/delivery-locations` (body: `{ ids: [...] }`) |
| Delete (all) | DELETE | `/api/v1/admin/settings/delivery-locations/all` |
| Check Pathao provider | GET | `/api/v1/admin/settings/delivery-providers` |
| Import chunk | POST | `/api/v1/admin/settings/delivery-locations/import-pathao` |
| Import status | GET | `/api/v1/admin/settings/delivery-locations/import-pathao/status` |
| Import reset | DELETE | `/api/v1/admin/settings/delivery-locations/import-pathao` |

## Pathao Import Flow

1. On mount, hook checks for active Pathao provider and any in-progress import
2. User clicks "Import from Pathao" button (only shown if active Pathao provider exists)
3. Confirmation dialog explains: updates existing, does not duplicate, may take minutes
4. `startImport()` resets progress and calls `resumeImport()`
5. `resumeImport()` loops: POST to `/import-pathao`, updates progress state, continues until complete or error. 50ms delay between chunks
6. On complete: success toast with creation/update counts, reloads location list
7. Progress banner shows: phase badge, progress bar, creation/update stats per type
8. "Reset & Re-import" clears KV progress and restarts

Abort mechanism: `importAbortRef` ref checked each iteration.

## Location Table Features

- **Checkbox selection**: individual + select-all header checkbox
- **Active toggle**: inline `Switch` with immediate API call (`PUT`)
- **External IDs display**: outline badges (`provider: id` format), or "None"
- **Pagination**: page numbers, previous/next buttons, page size dropdown

## Delete Operations

Three levels:
1. **Single delete**: `DELETE /{id}` (soft-delete)
2. **Bulk delete**: `DELETE /` with `{ ids: [...] }` -- only when checkboxes selected
3. **Clean all**: `DELETE /all` -- permanently removes ALL locations across all types

## Known Gaps

- Form dialog does not allow editing `externalIds`, `sortOrder`, or `metadata`
- Search uses SQL `LIKE %query%` (case-sensitive, no FTS5)
- Parent locations loaded with `limit=500` -- will miss parents if more than 500 exist
- No cascading check when deleting a city with child zones, or a zone with child areas
- Clean-all permanently deletes ALL data with no undo
