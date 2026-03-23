import { createFileRoute } from "@tanstack/react-router";
import { InventoryManager } from "~/components/admin/InventoryManager";

export const Route = createFileRoute("/admin/inventory")({
  head: () => ({ meta: [{ title: "Inventory | Scalius Admin" }] }),
  component: InventoryPage,
});

function InventoryPage() {
  return <InventoryManager />;
}
