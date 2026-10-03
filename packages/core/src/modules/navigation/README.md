# Navigation

Named storefront menus with a draft and an immutable published revision, the placements that put a published menu in the header or footer, resource resolution for menu links, and the reachable category tree. Read this before you change a menu write, a placement or a public navigation read.

## Entries and layer

`index.ts` is the only entry. There is no `browser.ts`. It exports `navigation.service`, `navigation.resolver`, `navigation.authority`, `navigation.authority.service`, `navigation.resources.service` and `navigation.categories`.

Layer L6. The domain imports `catalog`, `categories` and `pages`. `storefront` imports `navigation`. Shared link types and href parsing are in `@scalius/shared/navigation-target` and `navigation-href`.

## Owns

| Table | Key columns and constraints |
|-------|-----------------------------|
| `navigation_menus` | `id` (prefix `menu_`), `handle` (unique among live menus, lowercase), `revision` (draft edits), `published_revision`, `dependency_revision`, `deleted_at` |
| `navigation_menu_items` | The draft: `parent_id`, `position`, `label_mode` (`custom`, `resource`), `target_type`, `target_id`, `target_value`, `target_query`, `open_in_new_tab`, `is_enabled`. The target columns follow a CHECK per target type |
| `navigation_menu_publications`, `navigation_menu_publication_items` | One immutable row per published revision (`item_count`, `checksum`, `published_by`) and its item snapshot |
| `navigation_placements` | `surface`, `slot`, `position`, `menu_id` (`restrict`), `label_override`, `is_enabled`, `revision`. One enabled menu per location |

Target types: `label`, `system` (`home`, `catalog`, `search`, `account`, `cart`, `checkout`, `order_lookup`), `page`, `category`, `collection`, `product`, `internal_path`, `external_url` (credential-free HTTPS). A menu holds at most 10,000 items in at most 3 levels. Positions are sparse (gap 1,024).

Placement locations are fixed in `NAVIGATION_PLACEMENT_REGISTRY`: `header.primary` (one position) and `footer.column` (positions 0 to 3). Each placement renders at most 150 items. The domain declares no settings document.

DVC (`nav:<menuId>`): a draft edit invalidates nothing, because public reads show the published revision. Triggers on `pages`, `categories`, `collections` and `products` advance `navigation_menus.dependency_revision` when a linked resource changes its title, route or readiness. The resolver declares `deps.pages`, `deps.categories`, `deps.collections` and `deps.products` for every target id it reads.

## Routes

- Admin: `/api/v1/admin/navigation` in `apps/api/src/routes/admin/navigation.ts`: `GET`/`POST /menus`, `GET`/`PATCH`/`DELETE /menus/{menuId}`, `POST .../restore`, `.../publish`, `.../rollback`, `GET .../publications`, `GET`/`POST .../items`, `GET .../search`, `GET`/`PATCH`/`DELETE .../items/{itemId}`, `GET .../items/{itemId}/move-options`, `POST .../items/{itemId}/move`, `GET /placements`, `GET /placement-settings`, `PUT /placements/{placementId}`, `GET /resources`, `GET /preview-products`, `GET /items` (legacy picker).
- Public: `/api/v1/navigation` in `apps/api/src/routes/navigation.ts`: `GET /` (header and footer placements), `GET /categories`, `GET /placements`, `GET /menus/{menuId}` and `/menus/{menuId}/items` (take the current `revision` and `dependencyRevision`), `GET /{id}`.

Permissions are in `packages/core/src/auth/rbac/route-permissions/content.ts`: every admin navigation route needs `settings.header.edit`, except `/preview-products`, which needs `products.view`.

Menu lists, item lists, publication lists and resource search page by keyset cursor. `limit` is 1 to 100; the default is 50 (20 for resource search). Menus order by `updated_at` then id, items by `position` then id, publications by revision.

## Rules

- **Revision guard.** Every menu mutation (metadata, item create, update, move, delete, trash, restore, publish, rollback) claims `expectedRevision` and advances the menu `revision` by one in the same batch. A stale claim is `NAVIGATION_REVISION_CONFLICT` (409). A placement save claims its own revision (`NAVIGATION_PLACEMENT_REVISION_CONFLICT`); a new placement claims 0.
- **Publish.** `publishNavigationMenu` snapshots the draft items as a new publication at `revision + 1` with a SHA-256 checksum and sets `published_revision`. It refuses a menu that exceeds a placement it is in, a broken hierarchy, an unsupported system target or an enabled link to a resource that is not ready (page not published, category not published, collection not active, product not active, or trashed).
- **Rollback.** `rollbackNavigationMenu` restores an earlier publication into the draft and publishes it as a new revision. It verifies the checksum first.
- **Placements.** A menu must be published and fit the placement's 150 items before it is assigned. A menu with an enabled placement cannot be trashed.
- **Public placements.** `planPublishedNavigationPlacements` reads the manifest and the placed menus' published items in one batch. `planNavigationResourceSnapshots` reads the linked resources (at most 90 ids per statement) in a second batch. `getLayoutData` in `storefront` sends both inside its own two batches. A publication larger than its placement still renders, trimmed level by level and round-robin across parents (`trimNavigationHierarchy`). A placement whose rows do not match its count is skipped with a warning.
- **No fallback menu.** `GET /navigation` returns only placed menus. `buildDefaultNavigation` is exported but no route calls it.
- **Label.** In `resource` label mode the live resource title wins over the stored label.
- **Category tree.** `navigation.categories.ts` reads the reachable tree in one statement: published categories whose ancestors are all published and whose published subtree holds a public product, top levels first. The read returns at most 1,000 nodes (`CATEGORY_NAVIGATION_NODE_LIMIT`); the layout carries a round-robin cut of 150 (`CATEGORY_NAVIGATION_LAYOUT_NODES`). The theme's `blocks.navigation.source` chooses the header menu, the tree or both.
- **Preview count.** `getNavigationPreviewProductCount` counts a category link's products through `catalog`'s listing, so the count matches the storefront. It returns `countIsCapped` when the plan's count cap applies.
