import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { PriceListEditor } from "~/components/admin/price-lists/PriceListEditor";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { priceListQueryOptions } from "~/lib/api-query-options/price-lists";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/price-lists/$priceListId")({
  // One chunk for the page, its read and its error screen: fewer files in the first download's preload map.
  codeSplitGroupings: [["loader", "component", "errorComponent"]],
  loader: ({ context: { queryClient }, params }) => {
    // Only `pl_…` ids exist; anything else is a page that doesn't exist (no request).
    if (!/^pl_[A-Za-z0-9_-]{1,60}$/.test(params.priceListId)) throw new AdminApiResponseError("Price list not found", 404);
    return queryClient.ensureQueryData(priceListQueryOptions(params.priceListId));
  },
  head: () => pageHead("priceLists"),
  errorComponent: RouteErrorComponent,
  component: PriceListPage,
});

function PriceListPage() {
  const { priceListId } = Route.useParams();
  const { data } = useSuspenseQuery(priceListQueryOptions(priceListId));
  return <PriceListEditor key={data.id} priceList={data} />;
}
