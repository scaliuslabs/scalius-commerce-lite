import { NavigationMenuEditor } from "./NavigationMenuEditor";
import { NavigationMenusIndex } from "./NavigationMenusIndex";

export type NavigationWorkspacePanel = "items" | "placements" | "history";

export interface NavigationWorkspaceProps {
  /** Absent means the menus list; present means that menu's editor. */
  selectedMenuId?: string;
  panel: NavigationWorkspacePanel;
  query: string;
  itemId?: string;
  parentId?: string;
  onMenuChange: (menuId: string) => void;
  onPanelChange: (panel: NavigationWorkspacePanel) => void;
  onQueryChange: (query: string) => void;
  onItemChange: (itemId?: string, parentId?: string) => void;
}

/**
 * Navigation has two views and the `menu` search param decides which one:
 * the menus list, and one menu's editor. Keeping both on a single route means
 * the deep links other builders already use (`?panel=…`) stay valid, and the
 * editor can be reached without a page load.
 */
export function NavigationWorkspace({
  selectedMenuId,
  panel,
  query,
  itemId,
  parentId,
  onMenuChange,
  onPanelChange,
  onQueryChange,
  onItemChange,
}: NavigationWorkspaceProps) {
  if (!selectedMenuId) {
    return (
      <NavigationMenusIndex
        query={query}
        onQueryChange={onQueryChange}
        onOpenMenu={onMenuChange}
      />
    );
  }

  return (
    <NavigationMenuEditor
      // Remount on menu change so per-menu editor state never leaks across menus.
      key={selectedMenuId}
      menuId={selectedMenuId}
      panel={panel}
      query={query}
      itemId={itemId}
      parentId={parentId}
      onBackToMenus={() => onMenuChange("")}
      onPanelChange={onPanelChange}
      onQueryChange={onQueryChange}
      onItemChange={onItemChange}
    />
  );
}

export default NavigationWorkspace;
