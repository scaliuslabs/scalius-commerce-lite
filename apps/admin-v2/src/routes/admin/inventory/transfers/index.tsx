import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TransferList } from "~/components/admin/purchasing/TransferList";
import { transferListQuery, validateTransferListSearch } from "~/components/admin/purchasing/purchasing-list-state";
import { readListSearch } from "~/lib/list-search";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/inventory/transfers/")({
  // Only the status tab is shareable; the search stays in this tab's session.
  validateSearch: validateTransferListSearch,
  loaderDeps: ({ search }) => search,
  // The read's module comes with the page's own code, not the dashboard's first download.
  loader: async ({ context: { queryClient }, deps }) => {
    const { transfersQueryOptions: options } = await import("~/lib/api-query-options/purchasing");
    return warmRouteQuery(queryClient, options(transferListQuery(deps.status ?? "all", readListSearch("transfers"), 1, 50)));
  },
  head: () => pageHead("transfers"),
  errorComponent: RouteErrorComponent,
  component: TransfersPage,
});

function TransfersPage() {
  const { status } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <TransferList
      tab={status ?? "all"}
      onTabChange={(next) => void navigate({ search: next === "all" ? {} : { status: next }, replace: true })}
    />
  );
}
