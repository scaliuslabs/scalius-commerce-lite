# Footer Builder

Admin UI for configuring the storefront footer. Manages logo, tagline, description (rich text), copyright text, multiple navigation menu columns, and social links. Persists config as JSON in `siteSettings.footerConfig`.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports: `FooterBuilder`, all section components, all types |
| `types.ts` | `FooterConfig`, `FooterMenu`, `SocialLink`, `LogoConfig`, `NavigationItem`, `FooterBuilderProps`, `defaultFooterConfig`, `MediaFile` |
| `FooterBuilder.tsx` | Main component: tabbed UI (Branding & Text, Navigation Menus, Social Media), legacy config migration, save handler |
| `BrandingSection.tsx` | Footer logo upload via `MediaManager` with preview |
| `ContentSection.tsx` | Tagline (text input), description (lazy-loaded TipTap rich text editor), copyright text (text input) |
| `NavigationMenusSection.tsx` | Drag-reorderable accordion of footer menu columns. Each column has a title and embeds a `NavigationBuilder` for its links |
| `SocialLinksSection.tsx` | Drag-reorderable social links list (identical pattern to header-builder's version) |

## FooterConfig Shape

```typescript
interface FooterConfig {
  logo: { src: string; alt: string };
  tagline: string;
  description: string;          // HTML from TipTap editor
  copyrightText: string;
  menus: FooterMenu[];          // Multiple navigation columns
  social: SocialLink[];         // { id, label, url, iconUrl? }
}

interface FooterMenu {
  id: string;
  title: string;                // Column heading (e.g., "Quick Links", "Support")
  links: NavigationItem[];      // Recursive menu tree
}
```

## Legacy Config Migration

`migrateConfig()` runs on load and handles:

- Menu items missing `id` get `nanoid()` IDs
- Old `social` object format (`{ facebook: "url", twitter: "url" }`) converted to `SocialLink[]` array
- Old `social` array entries with `platform` field mapped to `label`
- Old `social` array entries with `icon` field mapped to `iconUrl`
- Missing `copyrightText` defaults to current year template

## NavigationMenusSection

Each footer column is a `FooterMenu` rendered inside a drag-reorderable `Accordion`. Features:

- **Drag reorder** columns via `@hello-pangea/dnd` (`Droppable` id `"menus"`, type `"MENU"`)
- **Inline title editing** in the accordion header
- **NavigationBuilder** embedded in each accordion body for the column's links
- **Accordion state persistence** via `localStorage` key `footer-builder-accordions`
- **getStorefrontPath** passes `() => "#"` (footer link preview is disabled)

## Save Flow

1. User clicks "Save Footer"
2. No validation gate (unlike header builder, logo is not required)
3. If `onSave` is a function, calls it with the config object
4. If `onSave` is a string, POSTs to that URL
5. Default: POSTs to `/api/v1/admin/settings/footer`

## API Endpoints Used

| Endpoint | Method | Used By | Purpose |
|----------|--------|---------|---------|
| `/api/v1/admin/settings/footer` | POST | FooterBuilder save | Persist entire footer config |
| `/api/v1/admin/navigation/items` | GET | AddNavItemDialog (via NavigationBuilder) | Fetch categories + pages for picker |

## Where It Is Used

`apps/admin/src/pages/admin/settings/index.astro` renders `GeneralSettingsPage` which lazy-loads `FooterBuilder` in the "Footer" tab. Initial config is fetched server-side alongside header config by `getGeneralSettingsData()`.

## Storefront Consumption

The storefront fetches the saved footer config through the public API:

- `GET /api/v1/footer` -- returns the full footer config unwrapped: `{ logo, tagline, copyrightText, menus, social, description }`

Storefront client: `apps/storefront/src/lib/api/footer.ts` -- `getFooterData()`, edge-cached with `CACHE_TTL.LONG`.

Note: The footer API route (`apps/api/src/routes/footer.ts`) reads `siteSettings.footerConfig` JSON and returns it mostly as-is, with fallbacks for missing fields.

## Shared Code with Header Builder

The `SocialLinksSection` is a near-identical copy between header-builder and footer-builder. Both use the same pattern: `@hello-pangea/dnd` drag, `MediaManager` for icon upload, label + URL inputs. The only differences are the `Droppable` id (`"header-social-links"` vs `"footer-social-links"`) and minor styling.

The `SocialLink`, `LogoConfig`, `NavigationItem`, and `MediaFile` types are also duplicated between header-builder/types.ts and footer-builder/types.ts.

## Known Gaps

- **No link preview**: Footer `NavigationBuilder` uses `getStorefrontPath={() => "#"}`, so the external link preview button in `SortableNavItem` always opens `#`. Header builder correctly uses the storefront URL hook.
- **Description HTML**: `ContentSection` uses a lazy-loaded TipTap editor for the description field, producing HTML. The storefront must render this HTML safely (dangerouslySetInnerHTML or equivalent).
- **Duplicated types**: `SocialLink`, `LogoConfig`, `NavigationItem`, `MediaFile` are copy-pasted between header-builder and footer-builder type files. Changes to one require manual sync to the other.
- **Duplicated SocialLinksSection**: The component is nearly identical between header and footer builders, differing only in Droppable ID. Could be extracted to a shared component.
