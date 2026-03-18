# Delivery Locations Admin UI

Admin interface for managing the city/zone/area location hierarchy used by delivery providers. No standalone Astro page -- the `DeliveryLocationsContainer` component is embedded within the checkout settings page.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports: `DeliveryLocationsContainer` (also aliased as `DeliveryLocationsManager`) |
| `DeliveryLocationsContainer.tsx` | Root component. Wires `useDeliveryLocations()` hook to child components. Contains tabs (Cities/Zones/Areas), search input, parent filter dropdown, action buttons. |
| `LocationsTable.tsx` | Data table with columns: checkbox, name, parent (if zone/area), status toggle, external IDs badges, edit/delete actions. Paginated with configurable page size (10/20/50/100). `LocationRow` is memoized. |
| `LocationFormDialog.tsx` | Dialog for creating/editing a location. Fields: name (required), parent selector (for zones/areas), active toggle. No external IDs editing in the form. |
| `PathaoImportPanel.tsx` | Three sub-components: `PathaoImportButton` (orange styled, only visible if active Pathao provider exists), `PathaoImportProgressBanner` (progress bar with stats), `PathaoImportConfirmDialog` (confirmation before starting) |
| `DeleteConfirmationDialogs.tsx` | Three dialogs: single delete, bulk delete (shows count), clean-all (permanent deletion warning) |
| `hooks/useDeliveryLocations.ts` | Central state hook. Manages: location data + pagination, form state, delete state, bulk selection, Pathao import lifecycle |

## Types

Defined in `hooks/useDeliveryLocations.ts`:

```typescript
interface Location {
  id: string;
  name: string;
  type: "city" | "zone" | "area";
  parentId: string | null;
  externalIds: Record<string, string | number>;
  metadata: Record<string, unknown>;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface PathaoImportProgress {
  status: "importing" | "complete" | "error";
  phase: "cities" | "zones" | "areas" | "done";
  progress: { current: number; total: number; label: string };
  stats: { citiesCreated, citiesUpdated, zonesCreated, zonesUpdated, areasCreated, areasUpdated };
  error?: string;
}

interface PaginationState { page, limit, total, totalPages }

interface LocationFormData { name, parentId, externalIds, isActive }
```

## Tab System

Three tabs with independent data loads:
- **Cities**: top-level, no parent filter
- **Zones**: parent filter = cities (loaded from API with `limit=500`)
- **Areas**: parent filter = zones (loaded from API with `limit=500`)

Tab change resets: `selectedParent` to null, `searchQuery` to empty.

## API Interactions

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

Response parsing: unwraps `json.data` if present and is a non-array object.

## Pathao Import Flow

1. On mount, hook checks for active Pathao provider (`providers.some(p => p.type === "pathao" && p.isActive)`) and for any in-progress import (via status endpoint)
2. User clicks "Import from Pathao" button (only shown if active Pathao provider exists)
3. Confirmation dialog explains: updates existing, does not duplicate, may take minutes
4. `startImport()` resets progress and calls `resumeImport()`
5. `resumeImport()` loops: POST to `/import-pathao`, updates progress state, continues until `status === "complete"` or `"error"`. 50ms delay between chunks.
6. On complete: success toast with creation/update counts, reloads location list
7. On error: error toast, retry button in banner
8. Progress banner shows: phase badge, progress bar (current/total), creation/update stats per type
9. "Reset & Re-import" clears KV progress and restarts

Abort mechanism: `importAbortRef` ref checked each iteration; set by `resetImport()`.

## Location Table Features

- **Checkbox selection**: individual row checkboxes + select-all header checkbox
- **Active toggle**: inline `Switch` component with immediate API call (`PUT` with `{ isActive: !current }`)
- **External IDs display**: rendered as outline badges (`provider: id` format), or "None" if empty
- **Pagination**: page numbers (up to 5 visible with sliding window), previous/next buttons, page size dropdown
- **Empty states**: different messages per tab type

## Form Dialog

- Create/edit mode determined by `editMode` flag
- Parent selector: required for zones (select city) and areas (select zone), hidden for cities
- Parent options loaded from API on tab change (`loadParentLocations`)
- Edit mode: populates form from existing location data
- Validation: name required, parent required for zones/areas
- On submit: POST (create) or PUT (update) with `{ name, type, parentId, externalIds, metadata, isActive }`
- Edit mode preserves existing `metadata`; create mode sets empty `{}`

## Delete Operations

Three levels:
1. **Single delete**: soft-delete via `DELETE /{id}` (sets `deletedAt`)
2. **Bulk delete**: soft-delete via `DELETE /` with `{ ids: [...] }` -- only enabled when checkboxes selected
3. **Clean all**: hard-delete via `DELETE /all` -- permanently removes ALL locations across all types. Confirmation dialog warns "irreversible" and "all delivery location data will be lost forever."

## Known Gaps

- No standalone Astro page for this component -- it is referenced by the delivery providers integration guide but there is no `/admin/settings/delivery-locations` route
- The form dialog does not allow editing `externalIds` -- these can only be set via API directly or via Pathao import
- The form dialog does not allow editing `sortOrder` or `metadata`
- Search uses SQL `LIKE %query%` which is case-sensitive in SQLite and does not use FTS5
- Parent locations loaded with `limit=500` -- will miss parents if more than 500 exist
- No confirmation or cascading check when deleting a city that has child zones, or a zone that has child areas
- The clean-all operation permanently deletes ALL data across ALL location types in a single operation with no undo
