# Navigation

Data layer for storefront navigation menus. Provides available linkable entities (categories, pages) that the admin navigation builder can reference.

## Files

- `index.ts` -- barrel re-exports everything from `navigation.service.ts`
- `navigation.service.ts` -- `NavigationService.getNavigationItems(db)`

## NavigationService.getNavigationItems(db)

Single method. Returns `{ categories, pages }` where each entry is `{ id, name, slug, type, url }`.

- **Categories**: selects `id, name, slug` from `categories` where `deletedAt IS NULL`, ordered by `name`. URL pattern: `/categories/{slug}`.
- **Pages**: selects `id, title, slug` from `pages` where `deletedAt IS NULL AND isPublished = true`, ordered by `title`. URL pattern: `/{slug}`.

The `type` field is a SQL literal (`'category'` or `'page'`), not a DB column.

## How It Is Used

### Admin Side

The `AddNavItemDialog` component (`apps/admin/src/components/admin/navigation/AddNavItemDialog.tsx`) fetches these items via `GET /api/v1/admin/navigation/items` to populate the category and page picker lists when adding navigation items to the header or footer builders.

### Admin API Route (`apps/api/src/routes/admin/navigation.ts`)

Manages navigation configuration stored in `siteSettings.headerConfig` / `siteSettings.footerConfig`:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/navigation/items` | Fetch categories + pages via `NavigationService.getNavigationItems(db)` |
| GET | `/admin/navigation` | Get header and footer config from `siteSettings` |
| POST | `/admin/navigation` | Save header or footer config (`{ type, config }`) -- creates settings row if none exists |
| PUT | `/admin/navigation/{id}` | Update config by settings ID |
| DELETE | `/admin/navigation/{id}` | Reset config to empty (`{ type }` in body) |

The recursive `NavigationItem` schema uses `z.lazy()` for type-safe recursive validation:

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

The save config body uses `z.record(z.string(), z.any())` for the config field to accommodate the flexible JSON structure. After saving, `invalidateSiteSettingsCache(getKv())` is called to bust the KV cache.

### Public Routes (Storefront)

The public `apps/api/src/routes/navigation.ts` does NOT use `NavigationService`. Instead, it reads `siteSettings.headerConfig` / `siteSettings.footerConfig` JSON directly. If no saved config exists, it falls back to building a default nav from categories + pages using inline queries (duplicating the logic).

Two endpoints:
- `GET /navigation` -- returns navigation by type (`header`, `footer`, or `all`). Falls back to auto-generated nav from categories + pages if no config saved. Cached 1h.
- `GET /navigation/{id}` -- returns a specific menu by id (`"header"`, `"footer"`, or a footer menu id/title match).

## Data Flow

```
NavigationService.getNavigationItems(db)
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
- `@scalius/core/modules/settings` -- `invalidateSiteSettingsCache`
- `nanoid` -- ID generation for new settings rows

## Known Gaps

- **Duplication**: The public `GET /navigation` route in `apps/api/src/routes/navigation.ts` duplicates the category/page query logic from this service instead of calling it. If the fallback default-nav generation logic changes, both locations need updating.
- **Public routes use raw `db` import**: Both `apps/api/src/routes/navigation.ts` and `apps/api/src/routes/header.ts` and `apps/api/src/routes/footer.ts` import `db` directly from `@scalius/database/client` instead of using `c.get("db")` from Hono context.
- **No product collections**: The service only surfaces categories and pages. Collections, custom URLs, and dynamic filtered links are handled entirely in the admin UI (the `AddNavItemDialog` "dynamic" type builds a URL client-side from category + attribute filters).
