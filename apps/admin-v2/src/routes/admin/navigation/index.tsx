import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RouteErrorComponent } from "~/lib/route-error";
import {
  NavigationWorkspace,
  type NavigationWorkspacePanel,
} from "~/components/admin/navigation-authority/NavigationWorkspace";

interface NavigationSearch {
  menu?: string;
  panel: NavigationWorkspacePanel;
  q: string;
  item?: string;
  parent?: string;
}

export function validateNavigationSearch(search: Record<string, unknown>): NavigationSearch {
  const panel = search.panel === "placements" || search.panel === "history"
    ? search.panel
    : "items";
  const menu = typeof search.menu === "string" && search.menu.trim()
    ? search.menu.trim()
    : undefined;
  const item = typeof search.item === "string" && search.item.trim()
    ? search.item.trim()
    : undefined;
  const parent = item === "new" && typeof search.parent === "string" && search.parent.trim()
    ? search.parent.trim()
    : undefined;
  const q = typeof search.q === "string" ? search.q.slice(0, 100) : "";
  return {
    ...(menu ? { menu } : {}),
    panel,
    q,
    ...(item ? { item } : {}),
    ...(parent ? { parent } : {}),
  };
}

export const Route = createFileRoute("/admin/navigation/")({
  validateSearch: validateNavigationSearch,
  head: () => ({ meta: [{ title: "Navigation | Scalius Admin" }] }),
  component: NavigationPage,
  errorComponent: RouteErrorComponent,
});

function NavigationPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const updateSearch = (updates: Partial<NavigationSearch>, replace = false) => {
    void navigate({
      search: ((current: NavigationSearch) => ({ ...current, ...updates })) as never,
      replace,
    });
  };

  return (
    <NavigationWorkspace
      selectedMenuId={search.menu}
      panel={search.panel}
      query={search.q}
      itemId={search.item}
      parentId={search.parent}
      onMenuChange={(menu) => updateSearch({ menu, panel: "items", q: "", item: undefined, parent: undefined })}
      onPanelChange={(panel) => updateSearch({ panel, item: undefined, parent: undefined })}
      onQueryChange={(q) => updateSearch({ q }, true)}
      onItemChange={(item, parent) => updateSearch({ item, parent })}
    />
  );
}
