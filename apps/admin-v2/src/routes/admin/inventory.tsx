import { createFileRoute } from "@tanstack/react-router";
import { InventoryManager } from "~/components/admin/InventoryManager";
import { inventoryQueryOptions } from "~/lib/api.queries";

export const Route = createFileRoute("/admin/inventory")({
  loader: async ({ context: { queryClient } }) => {
    // Prefetch the default view: variants tab, sorted by available ascending
    void queryClient.prefetchQuery(
      inventoryQueryOptions({ section: "variants", page: 1, limit: 50, sort: "available", order: "asc" }),
    );
  },
  head: () => ({ meta: [{ title: "Inventory | Scalius Admin" }] }),
  component: InventoryPage,
});

function InventoryPage() {
  return <InventoryManager />;
}
