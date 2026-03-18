# Header Builder

Admin UI for configuring the storefront header. Manages logo, favicon, announcement bar, contact info, social links, and navigation menu. Persists config as JSON in `siteSettings.headerConfig`.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports: `HeaderBuilder`, all section components, all types |
| `types.ts` | `HeaderConfig`, `SocialLink`, `TopBarConfig`, `LogoConfig`, `FaviconConfig`, `ContactConfig`, `NavigationItem`, `HeaderBuilderProps`, `defaultHeaderConfig`, `MediaFile` |
| `HeaderBuilder.tsx` | Main component: tabbed UI (Branding, Announcement, Contact & Social, Navigation), legacy config migration, save handler |
| `BrandingSection.tsx` | Logo + favicon upload via `MediaManager`, preview, alt text input. Logo is required (blocks save if missing) |
| `TopBarSection.tsx` | Announcement bar: enable/disable switch + text input |
| `ContactSection.tsx` | Contact info: phone + supporting text + enable/disable switch |
| `SocialLinksSection.tsx` | Drag-reorderable list of social links, each with label, URL, optional uploaded icon via `MediaManager`. Uses `@hello-pangea/dnd` |
| `NavigationSection.tsx` | Thin wrapper around `NavigationBuilder` from `../navigation/` |

## HeaderConfig Shape

```typescript
interface HeaderConfig {
  topBar: { text: string; isEnabled: boolean };
  logo: { src: string; alt: string };
  favicon: { src: string; alt: string };
  contact: { phone: string; text: string; isEnabled: boolean };
  social: SocialLink[];        // { id, label, url, iconUrl? }
  navigation: NavigationItem[]; // Recursive menu tree
}
```

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

The save endpoint is NOT the navigation admin route (`/admin/navigation`). The header builder uses a different settings endpoint that stores the entire header config blob.

## API Endpoints Used

| Endpoint | Method | Used By | Purpose |
|----------|--------|---------|---------|
| `/api/v1/admin/settings/header` | POST | HeaderBuilder save | Persist entire header config |
| `/api/v1/admin/navigation/items` | GET | AddNavItemDialog | Fetch categories + pages for picker |
| `/api/v1/admin/attributes?limit=100` | GET | AddNavItemDialog | Fetch filterable attributes for dynamic links |
| `/api/v1/admin/attributes/{id}/values` | GET | AddNavItemDialog | Fetch values for a specific attribute |
| `/api/v1/admin/navigation/preview-products` | GET | AddNavItemDialog | Preview product count for dynamic link |
| `/api/v1/admin/settings/storefront-url` | GET | `useStorefrontUrl` hook | Base URL for preview links |

## Where It Is Used

`apps/admin/src/pages/admin/settings/index.astro` renders `GeneralSettingsPage` which lazy-loads `HeaderBuilder` in the "Header" tab. Initial config is fetched server-side by `getGeneralSettingsData()` in `apps/admin/src/loaders/admin/settings.ts` via `GET /settings/general`.

## Storefront Consumption

The storefront fetches the saved header config through two separate public API routes:

1. `GET /api/v1/header` -- returns `{ header: { topBar, logo, favicon, contact, social } }` (strips navigation)
2. `GET /api/v1/navigation?type=header` -- returns `{ navigation: { header: NavigationItem[] } }`

Storefront clients:
- `apps/storefront/src/lib/api/header.ts` -- `getHeaderData()`, edge-cached
- `apps/storefront/src/lib/api/navigation.ts` -- `getNavigationData("header")`, edge-cached

Storefront components:
- `apps/storefront/src/components/header/header.astro` -- orchestrator
- `apps/storefront/src/components/header/HeaderLayout.astro` -- top bar, logo, contact, social, search, cart, scroll behavior
- `apps/storefront/src/components/header/DesktopNav.astro` -- horizontal nav with overflow "More" dropdown, `DynamicNav` class for responsive overflow
- `apps/storefront/src/components/header/RecursiveDesktopNav.astro` -- recursive flyout submenus (unlimited depth)
- `apps/storefront/src/components/header/MobileMenu.astro` -- slide-out panel with accordion submenus (3 levels hardcoded)

## Known Gaps

- **Social links format mismatch**: The admin saves `SocialLink` as `{ id, label, url, iconUrl? }`. The public header API route (`apps/api/src/routes/header.ts`) returns `social: { facebook: string }` -- it reads only `headerConfig.social?.facebook`, ignoring the new array format. The storefront `HeaderLayout.astro` handles both old and new formats by checking for `.label || .platform`.
- **TopBar.isEnabled not in public API**: The header API route returns only `topBar.text`, not `isEnabled`. The storefront `header.astro` defaults `isEnabled` to `true` if missing, so disabling the top bar in the admin may not take effect via the public header API. However, the storefront also reads the full config via the navigation route which may include the full headerConfig.
- **Mobile menu depth limit**: `MobileMenu.astro` hardcodes 3 levels of nesting. The admin builder supports 10 levels. Items deeper than level 3 are silently dropped in the mobile view.
- **Favicon not served**: The favicon config is saved but the storefront does not currently read it from the header API to set the HTML `<link rel="icon">` -- the storefront uses a static favicon.
