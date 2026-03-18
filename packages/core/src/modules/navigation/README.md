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

### API Route

`apps/api/src/routes/admin/navigation.ts` mounts the `/items` endpoint that calls `NavigationService.getNavigationItems(db)` and returns `{ items: { categories, pages } }`.

### Public Routes (Storefront)

The public `apps/api/src/routes/navigation.ts` does NOT use `NavigationService`. Instead, it reads `siteSettings.headerConfig` / `siteSettings.footerConfig` JSON directly. If no saved config exists, it falls back to building a default nav from categories + pages using inline queries (duplicating the logic).

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
                             POST /admin/settings/header (or /footer)
                                       |
                                       v
                             siteSettings.headerConfig / footerConfig (JSON in D1)
                                       |
                                       v
                             GET /header, GET /footer, GET /navigation  -->  Storefront
```

## Dependencies

- `@scalius/database` -- `categories`, `pages` schemas
- `drizzle-orm` -- `isNull`, `sql`

## Known Gaps

- **Duplication**: The public `GET /navigation` route in `apps/api/src/routes/navigation.ts` duplicates the category/page query logic from this service instead of calling it. If the fallback default-nav generation logic changes, both locations need updating.
- **No product collections**: The service only surfaces categories and pages. Collections, custom URLs, and dynamic filtered links are handled entirely in the admin UI (the `AddNavItemDialog` "dynamic" type builds a URL client-side from category + attribute filters).
