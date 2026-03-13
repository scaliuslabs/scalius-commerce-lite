# Navigation

Provides navigation item data (categories and published pages) for building site menus.

## Exports

- `NavigationService.getNavigationItems()` — returns all active categories and published pages formatted as navigation items with URLs

## Dependencies

- `@scalius/database` — `categories`, `pages` tables

## API Routes

- `GET /api/v1/navigation` — get navigation items for menu building
