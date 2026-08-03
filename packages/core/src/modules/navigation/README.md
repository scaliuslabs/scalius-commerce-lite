# Navigation

Data layer for storefront navigation menus. Provides linkable entities (categories, pages), CRUD for saved navigation configurations, and default navigation generation.

## Files

- `index.ts` -- barrel re-exports everything from `navigation.service.ts` and `navigation.validation.ts`
- `navigation.service.ts` -- service functions for navigation items and configuration management
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

### `getNavigationMenus(db)`

Returns header and footer configs from the `siteSettings` singleton. Stored JSON
is parsed and validated; malformed or unsafe persisted configuration raises an
explicit service-unavailable error instead of returning empty menus. Legacy
`/pages/{slug}` links normalize to the real public `/{slug}` route.

### `getNavigationMenu(db, id)`

Returns a single navigation config by ID. Accepts `"header"` or `"footer"` as the ID.

### `saveNavigationConfig(db, data)`

Validates and normalizes a navigation configuration before saving it. Internal
and relative links remain same-store; external links must be credential-free
HTTPS. Unsafe schemes, protocol-relative URLs, traversal, and unsafe characters
are rejected before any database write.

### `updateNavigationConfig(db, id, data)`

Updates an existing navigation config by settings ID. Updates either `headerConfig` or `footerConfig` based on `data.type`.

### `deleteNavigationConfig(db, id, type)`

Resets a navigation config to empty. Sets the corresponding config column (headerConfig or footerConfig) to `"{}"`.

### `buildDefaultNavigation(db)`

Generates default navigation from categories and pages when no custom navigation is configured. Returns `NestedNavigationItem[]` with a "Home" link, a "Categories" dropdown (if categories exist), and individual page links.

### `NavigationItem` interface

```typescript
interface NavigationItem {
    id: string;
    title: string;
    href?: string;
    subMenu?: NavigationItem[];
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

The `AddNavItemDialog` component (`apps/admin-v2/src/components/admin/navigation/AddNavItemDialog.tsx`) fetches items via `GET /api/v1/admin/navigation/items` to populate the category and page picker lists.

### Admin API Route (`apps/api/src/routes/admin/navigation.ts`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/navigation/items` | Fetch categories + pages via `getNavigationItems(db)` |
| GET | `/admin/navigation/preview-products` | Preview storefront product count for a dynamic category/filter link via `getNavigationPreviewProductCount(db, input)` |
| GET | `/admin/navigation` | Compatibility read for header/footer config plus independent revisions |
| POST | `/admin/navigation` | Deprecated compatibility save; requires `expectedRevision` and delegates to the settings CAS authority |
| PUT | `/admin/navigation/{id}` | Deprecated compatibility update through the same CAS authority |
| DELETE | `/admin/navigation/{id}` | Deprecated compatibility reset through the same CAS authority |

After saving, the route invalidates the layout cache through its request-scoped
`CACHE` binding and schedules the corresponding storefront purge.

### Public Routes (Storefront)

The public `apps/api/src/routes/navigation.ts` uses this service for navigation
menus, individual menus, and default navigation generation.

Two endpoints:
- `GET /navigation` -- returns navigation by type (`header`, `footer`, or `all`). Falls back to auto-generated nav from categories + pages if no config saved. Cached 1h.
- `GET /navigation/{id}` -- returns a specific menu by id (`"header"`, `"footer"`, or a footer menu id/title match).

## Data Flow

```
getNavigationItems(db)
    |
    v
API: GET /admin/navigation/items  -->  Admin AddNavItemDialog (picker)
                                       |
                                       v
                                  NavigationBuilder (tree editor)
                                       |
                                       v
                             HeaderBuilder / FooterBuilder
                                       |
                                       v
                             POST /admin/navigation (or PUT /admin/navigation/{id})
                                       |
                                       v
                             siteSettings.headerConfig / footerConfig (JSON in D1)
                                       |
                                       v
                             GET /header, GET /footer, GET /navigation  -->  Storefront
```

## Dependencies

- `@scalius/database` -- `categories`, `pages`, `siteSettings` schemas
- `drizzle-orm` -- `isNull`, `sql`, `eq`
- `nanoid` -- ID generation for new settings rows
- `zod` -- validation schemas

## Known Gaps

- **No product collections**: The service only surfaces categories and pages. Collections and custom URLs are still handled in the admin UI. Dynamic filtered category links are assembled client-side, with server-side count preview through `getNavigationPreviewProductCount()`.
