import { createFileRoute } from "@tanstack/react-router";
import { InventoryManager } from "~/components/admin/InventoryManager";
import { inventoryQueryOptions } from "~/lib/api-query-options/inventory";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/inventory")({
  loader: ({ context: { queryClient } }) => {
    if (typeof window === "undefined") return;

    void queryClient.prefetchQuery(
      inventoryQueryOptions({ section: "variants", page: 1, limit: 50, sort: "available", order: "asc" }),
    );
  },
  head: () => ({ meta: [{ title: "Inventory | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: InventoryPage,
});

function InventoryPage() {
  return <InventoryManager />;
}
