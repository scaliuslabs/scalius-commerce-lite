import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { TransferDetail } from "~/components/admin/purchasing/TransferDetail";
import { TransferEditor } from "~/components/admin/purchasing/TransferEditor";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { transferQueryOptions } from "~/lib/api-query-options/purchasing";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/inventory/transfers/$transferId/")({
  // The read's module comes with the page's own code, not the dashboard's first download.
  loader: async ({ context: { queryClient }, params }) => {
    const { transferQueryOptions: options } = await import("~/lib/api-query-options/purchasing");
    return queryClient.ensureQueryData(options(params.transferId));
  },
  head: () => pageHead("transfer"),
  errorComponent: RouteErrorComponent,
  component: TransferPage,
});

/** A draft opens in the editor (for staff who can edit); anything else in the detail view. */
function TransferPage() {
  const { transferId } = Route.useParams();
  const query = useSuspenseQuery(transferQueryOptions(transferId));
  const { inventory: { canAdjustStock: canEdit } } = useCatalogActionPermissions();
  // A reload after a conflict starts the page again from the latest copy.
  const [session, setSession] = useState(0);
  const reload = async () => {
    await query.refetch();
    setSession((current) => current + 1);
  };
  const transfer = query.data;
  const key = `${transfer.id}:${session}`;
  return transfer.status === "draft" && canEdit
    ? <TransferEditor key={key} transfer={transfer} onReload={reload} />
    : <TransferDetail key={key} transfer={transfer} onReload={reload} />;
}
