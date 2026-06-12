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

Returns header and footer configs from the `siteSettings` singleton. Each is JSON-parsed from `headerConfig` / `footerConfig`. Returns `{ header, footer }`.

### `getNavigationMenu(db, id)`

Returns a single navigation config by ID. Accepts `"header"` or `"footer"` as the ID.

### `saveNavigationConfig(db, data)`

Saves a navigation configuration. Uses `siteSettings` singleton upsert (insert with `onConflictDoUpdate` targeting `singletonKey`). Accepts `{ type: "header" | "footer", config }`. Generates a `settings_` prefixed nanoid for new rows.

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
        href: z.string().optional(),
        subMenu: z.array(navigationItemSchema).optional(),
    })
);
```

### `headerConfigSchema` / `footerConfigSchema`

Schemas for header and footer configuration. The header config includes `topBar`, `logo`, `favicon`, `contact`, `social`, and `navigation` fields. The footer config includes `logo`, `tagline`, `description`, `copyrightText`, `menus`, and `social` fields.

### `saveNavigationConfigSchema`

Schema for the save operation: `{ type: "header" | "footer", config: z.record(z.string(), z.unknown()) }`. Uses `z.record()` for the config field to accommodate the flexible JSON structure.

Exported type: `SaveNavigationConfigInput`.

## How It Is Used

### Admin Side

The `AddNavItemDialog` component (`apps/admin-v2/src/components/admin/navigation/AddNavItemDialog.tsx`) fetches items via `GET /api/v1/admin/navigation/items` to populate the category and page picker lists.

### Admin API Route (`apps/api/src/routes/admin/navigation.ts`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/navigation/items` | Fetch categories + pages via `getNavigationItems(db)` |
| GET | `/admin/navigation/preview-products` | Preview storefront product count for a dynamic category/filter link via `getNavigationPreviewProductCount(db, input)` |
| GET | `/admin/navigation` | Get header and footer config via `getNavigationMenus(db)` |
| POST | `/admin/navigation` | Save config via `saveNavigationConfig(db, data)` -- creates settings row if none exists |
| PUT | `/admin/navigation/{id}` | Update config via `updateNavigationConfig(db, id, data)` |
| DELETE | `/admin/navigation/{id}` | Reset config via `deleteNavigationConfig(db, id, type)` (`{ type }` in body) |

After saving, `invalidateSiteSettingsCache(getKv())` is called to bust the KV cache.

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

- **Public routes use raw `db` import**: Both `apps/api/src/routes/navigation.ts` and `apps/api/src/routes/header.ts` and `apps/api/src/routes/footer.ts` import `db` directly from `@scalius/database/client` instead of using `c.get("db")` from Hono context.
- **No product collections**: The service only surfaces categories and pages. Collections and custom URLs are still handled in the admin UI. Dynamic filtered category links are assembled client-side, with server-side count preview through `getNavigationPreviewProductCount()`.
