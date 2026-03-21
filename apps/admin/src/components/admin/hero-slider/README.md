# Hero Slider Components

Admin UI for managing homepage hero banner sliders. Supports separate desktop and mobile sliders with drag-and-drop reordering.

## Files

| File | Description |
|------|-------------|
| `index.ts` | Barrel exports: `HeroSliderContainer`, aliased as `HeroSliderManager` |
| `helpers.ts` | Type definitions (`SliderImage`, `HeroSlider`) and `generateImageId()` utility. Re-exports `MediaFile` from `@/components/admin/media-manager/types` |
| `HeroSliderContainer.tsx` | Top-level container. Manages desktop/mobile slider state, fetches from API, handles create/update/delete with optimistic updates and debounced image field saves |
| `SliderTab.tsx` | Per-slider (desktop or mobile) tab content. DnD context with `@dnd-kit/core` + `@dnd-kit/sortable`. Media manager integration for adding slides. Empty state with create button. Active/inactive toggle. Recommended size badges (desktop: 1400x450px, mobile: 640x200px) |
| `SortableSlide.tsx` | Individual sortable slide card. Image preview with optimized URL, title/alt text input, destination URL input, remove button. Uses `useSortable` hook |
| `SlideOverlay.tsx` | Drag overlay ghost shown during DnD operations. Rendered via React portal to `document.body` |

## Data Model

### `HeroSlider`
```typescript
{ id: string; type: "desktop" | "mobile"; images: SliderImage[]; isActive: boolean }
```

### `SliderImage`
```typescript
{ id: string; url: string; title: string; link: string }
```

## Behavior

- **One slider per type**: API enforces uniqueness (ConflictError if desktop/mobile slider already exists)
- **Soft-delete on API**: `deletedAt` timestamp, not shown in admin list
- **Debounced saves**: Image title/link edits are debounced (500ms) before persisting to API
- **Optimistic updates**: Local state updates immediately, API call follows
- **Drag-and-drop**: Reorders images array via `@dnd-kit`, persists on drag end
- **Media integration**: Uses `MediaManager` component for image selection (single + multi-select)
- **Image optimization**: Uses `@scalius/shared/image-optimizer.getOptimizedImageUrl()` for previews

## API Endpoints Used

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/settings/hero-sliders` | List all non-deleted sliders |
| POST | `/admin/settings/hero-sliders` | Create slider (one per type) |
| PUT | `/admin/settings/hero-sliders/{id}` | Update slider (images, isActive) |

## Dependencies

- `@dnd-kit/core`, `@dnd-kit/sortable` -- drag-and-drop
- `@scalius/shared/image-optimizer` -- `getOptimizedImageUrl()`
- `@scalius/shared/utils` -- `cn()`
- shadcn/ui components (Tabs, Card, Button, Switch, Badge, Label, Input)
- `sonner` for toast notifications
- `@/hooks/use-debounced-callback` -- `useDebouncedCallback()` debounce wrapper
- `@/lib/api-helpers` -- `unwrapEnvelope()`, `extractApiError()` for API response handling
- `@/components/admin/media-manager` -- MediaManager for image selection
