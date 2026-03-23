# Header Builder

Admin UI for configuring the storefront header. Manages logo, favicon, announcement bar, contact info, social links, and navigation menu. Persists config as JSON in `siteSettings.headerConfig`.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports: `HeaderBuilder`, all section components, all types |
| `types.ts` | `HeaderConfig`, `TopBarConfig`, `FaviconConfig`, `ContactConfig`, `HeaderBuilderProps`, `defaultHeaderConfig`. Re-exports `SocialLink`, `LogoConfig` from `@/components/admin/shared/builder-types`, `NavigationItem` from `@/components/admin/navigation/types`, `MediaFile` from `@/components/admin/media-manager/types` |
| `HeaderBuilder.tsx` | Main component: tabbed UI (Branding, Announcement, Contact & Social, Navigation), legacy config migration, save handler |
| `BrandingSection.tsx` | Logo + favicon upload via `MediaManager`, preview, alt text input. Logo is required (blocks save if missing) |
| `TopBarSection.tsx` | Announcement bar: enable/disable switch + text input |
| `ContactSection.tsx` | Contact info: phone + supporting text + enable/disable switch |
| `SocialLinksSection.tsx` | Drag-reorderable list of social links, each with label, URL, optional uploaded icon via `MediaManager`. Uses `@hello-pangea/dnd` |
| `NavigationSection.tsx` | Thin wrapper around `NavigationBuilder` from `../navigation/` |

## HeaderConfig Shape

```typescript
interface HeaderConfig {
  topBar: TopBarConfig;       // { text, isEnabled }
  logo: LogoConfig;           // { src, alt }
  favicon: FaviconConfig;     // { src, alt }
  contact: ContactConfig;     // { phone, text, isEnabled }
  social: SocialLink[];       // { id, label, url, iconUrl? }
  navigation: NavigationItem[]; // Recursive menu tree
}
```

## Shared Types

Types are imported from shared locations (no longer duplicated):
- `SocialLink`, `LogoConfig` from `@/components/admin/shared/builder-types`
- `NavigationItem` from `@/components/admin/navigation/types`
- `MediaFile` from `@/components/admin/media-manager/types`

## Legacy Config Migration

`migrateConfig()` runs on load and handles:

- Missing `topBar.isEnabled` defaults to `true`
- Missing `contact.isEnabled` defaults to `true`
- Old `social` object format (`{ facebook: "url" }`) converted to `SocialLink[]` array
- Navigation items missing `id` get `nanoid()` IDs
- Navigation items missing `subMenu` get empty array

## Save Flow

1. User clicks "Save Header Settings"
2. Validates logo.src is present (blocks save with toast + tab switch if missing)
3. If `onSave` is a function, calls it with the config object
4. If `onSave` is a string, POSTs to that URL
5. Default: POSTs to `/api/v1/admin/settings/header`

## API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/admin/settings/header` | POST | Persist entire header config |
| `/api/v1/admin/navigation/items` | GET | Fetch categories + pages for picker |
| `/api/v1/admin/attributes?limit=100` | GET | Fetch filterable attributes for dynamic links |
| `/api/v1/admin/attributes/{id}/values` | GET | Fetch values for a specific attribute |
| `/api/v1/admin/navigation/preview-products` | GET | Preview product count for dynamic link |
| `/api/v1/admin/settings/storefront-url` | GET | Base URL for preview links |

## Where It Is Used

`apps/admin/src/pages/admin/settings/index.astro` renders `GeneralSettingsPage` which lazy-loads `HeaderBuilder` in the "Header" tab.

## Storefront Consumption

The storefront fetches the saved header config through two separate public API routes:

1. `GET /api/v1/header` -- returns `{ header: { topBar, logo, favicon, contact, social } }` (strips navigation)
2. `GET /api/v1/navigation?type=header` -- returns `{ navigation: { header: NavigationItem[] } }`

Storefront clients:
- `apps/storefront/src/lib/api/header.ts` -- `getHeaderData()`, edge-cached
- `apps/storefront/src/lib/api/navigation.ts` -- `getNavigationData("header")`, edge-cached

## Known Gaps

- **TopBar.isEnabled not in public API**: The header API route returns only `topBar.text`, not `isEnabled`. The storefront defaults `isEnabled` to `true` if missing.
- **Mobile menu depth limit**: `MobileMenu.astro` hardcodes 3 levels. The admin builder supports 10 levels. Items deeper than level 3 are silently dropped.
- **Favicon not served**: The favicon config is saved but the storefront does not read it from the header API to set `<link rel="icon">` -- uses a static favicon.
