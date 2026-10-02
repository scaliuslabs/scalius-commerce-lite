import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PurchaseOrderReceive } from "~/components/admin/purchasing/PurchaseOrderReceive";
import { purchaseOrderQueryOptions } from "~/lib/api-query-options/purchasing";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/inventory/purchase-orders/$purchaseOrderId/receive")({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(purchaseOrderQueryOptions(params.purchaseOrderId)),
  head: () => pageHead("receiveItems"),
  errorComponent: RouteErrorComponent,
  component: ReceivePurchaseOrderPage,
});

function ReceivePurchaseOrderPage() {
  const { purchaseOrderId } = Route.useParams();
  const query = useSuspenseQuery(purchaseOrderQueryOptions(purchaseOrderId));
  // A reload after a conflict starts the count again from the latest copy.
  const [session, setSession] = useState(0);
  const reload = async () => {
    await query.refetch();
    setSession((current) => current + 1);
  };
  return <PurchaseOrderReceive key={`${query.data.id}:${session}`} order={query.data} onReload={reload} />;
}
