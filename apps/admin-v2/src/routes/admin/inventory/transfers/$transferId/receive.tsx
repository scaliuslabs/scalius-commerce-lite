import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { TransferReceive } from "~/components/admin/purchasing/TransferReceive";
import { transferQueryOptions } from "~/lib/api-query-options/purchasing";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/inventory/transfers/$transferId/receive")({
  // The read's module comes with the page's own code, not the dashboard's first download.
  loader: async ({ context: { queryClient }, params }) => {
    const { transferQueryOptions: options } = await import("~/lib/api-query-options/purchasing");
    return queryClient.ensureQueryData(options(params.transferId));
  },
  head: () => pageHead("receiveItems"),
  errorComponent: RouteErrorComponent,
  component: ReceiveTransferPage,
});

function ReceiveTransferPage() {
  const { transferId } = Route.useParams();
  const query = useSuspenseQuery(transferQueryOptions(transferId));
  // A reload after a conflict starts the count again from the latest copy.
  const [session, setSession] = useState(0);
  const reload = async () => {
    await query.refetch();
    setSession((current) => current + 1);
  };
  return <TransferReceive key={`${query.data.id}:${session}`} transfer={query.data} onReload={reload} />;
}
