import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PurchaseOrderDetail } from "~/components/admin/purchasing/PurchaseOrderDetail";
import { PurchaseOrderEditor } from "~/components/admin/purchasing/PurchaseOrderEditor";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { purchaseOrderQueryOptions } from "~/lib/api-query-options/purchasing";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/inventory/purchase-orders/$purchaseOrderId/")({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(purchaseOrderQueryOptions(params.purchaseOrderId)),
  head: () => pageHead("purchaseOrder"),
  errorComponent: RouteErrorComponent,
  component: PurchaseOrderPage,
});

/** A draft opens in the editor (for staff who can edit); anything else in the detail view. */
function PurchaseOrderPage() {
  const { purchaseOrderId } = Route.useParams();
  const query = useSuspenseQuery(purchaseOrderQueryOptions(purchaseOrderId));
  const { inventory: { canAdjustStock: canEdit } } = useCatalogActionPermissions();
  // A reload after a conflict starts the page again from the latest copy.
  const [session, setSession] = useState(0);
  const reload = async () => {
    await query.refetch();
    setSession((current) => current + 1);
  };
  const order = query.data;
  const key = `${order.id}:${session}`;
  return order.status === "draft" && canEdit
    ? <PurchaseOrderEditor key={key} order={order} onReload={reload} />
    : <PurchaseOrderDetail key={key} order={order} onReload={reload} />;
}
