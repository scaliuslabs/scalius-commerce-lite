import { createFileRoute } from "@tanstack/react-router";
import { PurchaseOrderEditor } from "~/components/admin/purchasing/PurchaseOrderEditor";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/inventory/purchase-orders/new")({
  head: () => pageHead("createPurchaseOrder"),
  errorComponent: RouteErrorComponent,
  component: () => <PurchaseOrderEditor order={null} />,
});
