# Navigation

Normalized navigation authority plus bounded resource-picker compatibility reads.

## Files

- `index.ts` -- barrel re-exports the navigation services and validation modules
- `navigation.service.ts` -- bounded legacy picker and product-count preview reads
- `navigation.authority.service.ts` -- canonical revision-fenced menu, publication, and placement authority
- `navigation.validation.ts` -- Zod schemas for navigation configuration

## Service Functions

### `getNavigationItems(db)`

Returns `{ categories, pages }` where each entry is `{ id, name, slug, type, url }`.

- **Categories**: selects `id, name, slug` from `categories` where `deletedAt IS NULL`, ordered by `name`. URL pattern: `/categories/{slug}`.
- **Pages**: selects `id, title, slug` from `pages` where `deletedAt IS NULL AND isPublished = true`, ordered by `title`. URL pattern: `/{slug}`.

The `type` field is a SQL literal (`'category'` or `'page'`), not a DB column.

### `getNavigationPreviewProductCount(db, input)`

Returns `{ count }` for an admin dynamic navigation link preview. It verifies
the category is public via `getPublicCategoryById()` and delegates to
`getStorefrontProducts()` with `limit: 1`, so the count matches the storefront
category filtering rules without loading product rows into the admin worker.

Accepted input:

```typescript
{
    categoryId: string;
    search?: string;
    minPrice?: number;
    maxPrice?: number;
    freeDelivery?: "true" | "false";
    hasDiscount?: "true" | "false";
    attributeFilters?: { slug: string; value: string }[];
}
```

## Validation Schemas

From `navigation.validation.ts`:

### `navigationItemSchema`

Recursive schema using `z.lazy()` for type-safe nested navigation items:

```typescript
const navigationItemSchema: z.ZodType<NavigationItem> = z.lazy(() =>
    z.object({
        id: z.string(),
        title: z.string(),
        href: navigationHrefSchema,
        subMenu: z.array(navigationItemSchema).optional(),
    })
);
```

### `headerConfigSchema` / `footerConfigSchema`

Schemas for header and footer configuration. The header config includes `topBar`, `logo`, `favicon`, `contact`, `social`, and `navigation` fields. The footer config includes `logo`, `tagline`, `description`, `copyrightText`, `menus`, and `social` fields.

### `saveNavigationConfigSchema`

`parseNavigationConfig(type, config)` selects the matching header/footer schema,
recursively validates links, and returns the normalized persisted shape. Empty
or legacy `#` hrefs become label-only nodes.

Exported type: `SaveNavigationConfigInput`.

## How It Is Used

### Admin Side

The canonical `NavigationWorkspace` uses the bounded
`GET /api/v1/admin/navigation/resources` picker and the normalized menu,
publication, and placement operations. Header and footer builders link to this
workspace; they do not embed a second menu editor.

### Admin API Route (`apps/api/src/routes/admin/navigation.ts`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/navigation/items` | Fetch categories + pages via `getNavigationItems(db)` |
| GET | `/admin/navigation/preview-products` | Preview storefront product count for a dynamic category/filter link via `getNavigationPreviewProductCount(db, input)` |
| GET | `/admin/navigation/resources` | Bounded resource picker with keyset pagination and selected-ID hydration |
| GET/POST | `/admin/navigation/menus/*` | Normalized menu reads and revision-fenced commands |
| GET/POST | `/admin/navigation/placements/*` | Independent placement reads and revision-fenced commands |

After saving, the route invalidates the layout cache through its request-scoped
`CACHE` binding and schedules the corresponding storefront purge.

### Public Routes (Storefront)

The public `apps/api/src/routes/navigation.ts` reads immutable published menus
and the normalized placement manifest.

Primary endpoints:
- `GET /navigation` -- resolves header/footer projections from published placements.
- `GET /navigation/placements` -- returns the uncached placement manifest.
- `GET /navigation/menus/{menuId}` -- returns one bounded immutable publication.
- `GET /navigation/menus/{menuId}/items` -- pages large published menus by parent.

## Data Flow

```
GET /admin/navigation/resources
    |
    v
NavigationWorkspace  -->  revision-fenced menu draft commands
    |                               |
    |                               v
    |                      immutable publication rows
    |                               |
    v                               v
placement commands  -->  GET /navigation + revision-keyed menu projections
```

## Dependencies

- `@scalius/database` -- `categories`, `pages`, `siteSettings` schemas
- `drizzle-orm` -- `isNull`, `sql`, `eq`
- `nanoid` -- ID generation for new settings rows
- `zod` -- validation schemas

## Known Gaps

- **No product collections**: The service only surfaces categories and pages. Collections and custom URLs are still handled in the admin UI. Dynamic filtered category links are assembled client-side, with server-side count preview through `getNavigationPreviewProductCount()`.
