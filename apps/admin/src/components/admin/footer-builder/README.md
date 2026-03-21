# Footer Builder

Admin UI for configuring the storefront footer. Manages logo, tagline, description (rich text), copyright text, multiple navigation menu columns, and social links. Persists config as JSON in `siteSettings.footerConfig`.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports: `FooterBuilder`, all section components, all types |
| `types.ts` | `FooterConfig`, `FooterMenu`, `FooterBuilderProps`, `defaultFooterConfig`. Re-exports `SocialLink`, `LogoConfig` from `@/components/admin/shared/builder-types`, `NavigationItem` from `@/components/admin/navigation/types`, `MediaFile` from `@/components/admin/media-manager/types` |
| `FooterBuilder.tsx` | Main component: tabbed UI (Branding & Text, Navigation Menus, Social Media), legacy config migration, save handler |
| `BrandingSection.tsx` | Footer logo upload via `MediaManager` with preview |
| `ContentSection.tsx` | Tagline (text input), description (lazy-loaded TipTap rich text editor), copyright text (text input) |
| `NavigationMenusSection.tsx` | Drag-reorderable accordion of footer menu columns. Each column has a title and embeds a `NavigationBuilder` for its links |
| `SocialLinksSection.tsx` | Drag-reorderable social links list (identical pattern to header-builder's version) |

## FooterConfig Shape

```typescript
interface FooterConfig {
  logo: LogoConfig;           // { src, alt }
  tagline: string;
  description: string;        // HTML from TipTap editor
  copyrightText: string;
  menus: FooterMenu[];        // Multiple navigation columns
  social: SocialLink[];       // { id, label, url, iconUrl? }
}

interface FooterMenu {
  id: string;
  title: string;              // Column heading (e.g., "Quick Links", "Support")
  links: NavigationItem[];    // Recursive menu tree
}
```

## Shared Types

Types are imported from shared locations (no longer duplicated):
- `SocialLink`, `LogoConfig` from `@/components/admin/shared/builder-types`
- `NavigationItem` from `@/components/admin/navigation/types`
- `MediaFile` from `@/components/admin/media-manager/types`

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

## Save Flow

1. User clicks "Save Footer"
2. No validation gate (unlike header builder, logo is not required)
3. If `onSave` is a function, calls it with the config object
4. If `onSave` is a string, POSTs to that URL
5. Default: POSTs to `/api/v1/admin/settings/footer`

## API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/admin/settings/footer` | POST | Persist entire footer config |
| `/api/v1/admin/navigation/items` | GET | Fetch categories + pages for picker (via NavigationBuilder) |

## Where It Is Used

`apps/admin/src/pages/admin/settings/index.astro` renders `GeneralSettingsPage` which lazy-loads `FooterBuilder` in the "Footer" tab.

## Storefront Consumption

- `GET /api/v1/footer` -- returns the full footer config
- Storefront client: `apps/storefront/src/lib/api/footer.ts` -- `getFooterData()`, edge-cached

## Known Gaps

- **No link preview**: Footer `NavigationBuilder` uses `getStorefrontPath={() => "#"}`, so external link preview always opens `#`
- **Description HTML**: The storefront must render `description` HTML safely
