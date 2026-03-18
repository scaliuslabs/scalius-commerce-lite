# Navigation Builder

Recursive drag-and-drop menu editor used by both the header builder and footer builder. Supports unlimited nesting (capped at 10 levels), drag reorder, indent/outdent, and five item types.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports: `NavigationBuilder`, `SortableNavItem`, `AddNavItemDialog`, all types |
| `types.ts` | `NavigationItem`, `NavigationSource`, `NavigationSources`, props interfaces, `MAX_NAV_DEPTH` (10), `getDepthColor()` |
| `NavigationBuilder.tsx` | Main component: `DragDropContext` + `Droppable` table, stats badge, add/remove/update/indent/outdent/drag handlers |
| `SortableNavItem.tsx` | Single row: `Draggable` table row with inline title/URL editing, depth badges, expand/collapse, dropdown actions, recursive children via nested `Droppable` |
| `AddNavItemDialog.tsx` | Modal dialog for adding items: category picker, page picker, dynamic link builder, custom link, label-only |

## NavigationItem Shape

```typescript
interface NavigationItem {
  id: string;       // nanoid, generated client-side
  title: string;    // Display label
  href?: string;    // URL (undefined = label-only, non-clickable)
  subMenu?: NavigationItem[];  // Recursive children
}
```

An item can have BOTH `href` and `subMenu` -- this creates a "Link+Menu" that is both clickable and has a dropdown.

## NavigationBuilder Props

```typescript
interface NavigationBuilderProps {
  navigation: NavigationItem[];
  onChange: (navigation: NavigationItem[]) => void;
  getStorefrontPath: (path: string) => string;
}
```

The builder is a controlled component. Parent owns the navigation array and receives changes via `onChange`.

## Tree Manipulation

All operations use path-based indexing (dot-separated indices like `"0.2.1"` = root item 0, child 2, grandchild 1):

- **updateItem(path, index, updates)**: Immutable recursive map to update a single item
- **removeItem(path, index)**: Immutable recursive filter
- **addItemsToPath(items, parentPath)**: Appends items to a parent's `subMenu`, or root if `parentPath` is null
- **handleIndent(path, index)**: Removes item, appends it to previous sibling's `subMenu`
- **handleOutdent(path, index)**: Removes item from parent's `subMenu`, inserts after parent in grandparent's list
- **handleDragEnd(result)**: Reorders within same `Droppable` (main nav or specific submenu). Cross-list drag is NOT supported.

## AddNavItemDialog

Five item types, switchable via tab bar:

| Type | Source | Behavior |
|------|--------|----------|
| `category` | `GET /api/v1/admin/navigation/items` | Multi-select checkbox list, search filter. Creates items with `href: /categories/{slug}` |
| `page` | Same endpoint | Multi-select checkbox list. Creates items with `href: /{slug}` |
| `dynamic` | Category select + attribute filters | Builds a URL like `/categories/{slug}?page=1&sortBy=newest&{attr}={val}`. Fetches attribute values via `GET /api/v1/admin/attributes/{id}/values`. Preview count via `GET /api/v1/admin/navigation/preview-products` |
| `custom` | User input | Freeform label + URL |
| `label` | User input | Label only, no href. Used as non-clickable dropdown headers |

All IDs are generated client-side with `nanoid()`.

## Drag-and-Drop

Uses `@hello-pangea/dnd` (maintained fork of react-beautiful-dnd).

- Root level: `Droppable` id `"main-navigation"`, type `"MAIN_NAV"`
- Each submenu: `Droppable` id `"submenu-{parentId}"`, type `"SUBMENU_{parentId}"`
- Each item: `Draggable` id = item.id

Reorder only works within the same `Droppable`. Moving items between levels requires indent/outdent.

## Visual Features

- Depth-colored left border (blue, green, purple, orange, pink, cyan, yellow, red, indigo, teal -- cycles)
- Level badges (`L2`, `L3`, etc.) on nested items
- `Label` badge on items without href
- `Link+Menu` badge on items with both href and subMenu
- Item count badge on parents
- Expand/collapse toggle for submenus
- External link button to preview URL in storefront

## Where It Is Used

1. **HeaderBuilder** (`../header-builder/NavigationSection.tsx`): Thin wrapper passing `navigation`, `onChange`, `getStorefrontPath`
2. **FooterBuilder** (`../footer-builder/NavigationMenusSection.tsx`): Each footer menu column embeds a `NavigationBuilder` for its links. `getStorefrontPath` returns `"#"` (footer links are not previewable).

## Known Gaps

- **No cross-list drag**: Items cannot be dragged between root and submenu levels, or between different submenus. Only indent/outdent supports reparenting.
- **Props mismatch**: `SortableNavItem` declares its own local `SortableNavItemProps` interface (with `onAddChild`, `onIndent`, `onOutdent`, `canIndent`, `canOutdent`) that differs from the exported interface in `types.ts` (which has `onAddSubItem` and no indent/outdent). The exported interface in `types.ts` is dead code.
- **AddNavItemDialog props mismatch**: The exported `AddNavItemDialogProps` in `types.ts` has `{ open, onOpenChange, onAddItems }` but the actual component uses `{ open, onClose, onAdd, parentLabel, getStorefrontPath }`. The exported interface is dead code.
- **Envelope handling**: The dialog's `fetchAttributeValues` and preview-products fetch both manually handle the `{ data: ... }` envelope with a conditional check, suggesting the response shape has changed over time.
