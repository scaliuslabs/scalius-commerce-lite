import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { InventoryManager } from "~/components/admin/InventoryManager";
import {
  normalizeInventoryWorkspaceSection,
  type InventoryWorkspaceSection,
} from "~/components/admin/inventory-workspace";
import { inventoryQueryOptions } from "~/lib/api-query-options/inventory";
import { RouteErrorComponent } from "~/lib/route-error";

export function validateInventorySearch(search: Record<string, unknown>) {
  return { section: normalizeInventoryWorkspaceSection(search.section) };
}

export const Route = createFileRoute("/admin/inventory")({
  validateSearch: validateInventorySearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => {
    if (typeof window === "undefined") return;

    if (deps.section === "variants") {
      void queryClient.prefetchQuery(
        inventoryQueryOptions({ section: "variants", page: 1, limit: 50, sort: "available", order: "asc" }),
      );
    } else if (deps.section === "alerts") {
      void queryClient.prefetchQuery(
        inventoryQueryOptions({ section: "alerts", alertStatus: "active", page: 1, limit: 20 }),
      );
    } else {
      void queryClient.prefetchQuery(
        inventoryQueryOptions({ section: "movements", movementType: "all", limit: 50 }),
      );
    }
  },
  head: () => ({ meta: [{ title: "Inventory | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: InventoryPage,
});

function InventoryPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const handleSectionChange = useCallback(
    (section: InventoryWorkspaceSection) => {
      void navigate({
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          section,
        })) as never,
      });
    },
    [navigate],
  );

  return (
    <InventoryManager
      section={search.section}
      onSectionChange={handleSectionChange}
    />
  );
}
