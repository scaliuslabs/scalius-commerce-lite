import { createFileRoute } from "@tanstack/react-router";
import { PriceListsList } from "~/components/admin/price-lists/PriceListsList";
import { priceListsQueryOptions } from "~/lib/api-query-options/price-lists";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/price-lists/")({
  // One chunk for the page, its read and its error screen: fewer files in the first download's preload map.
  codeSplitGroupings: [["loader", "component", "errorComponent"]],
  loader: ({ context: { queryClient } }) => warmRouteQuery(queryClient, priceListsQueryOptions()),
  head: () => pageHead("priceLists"),
  errorComponent: RouteErrorComponent,
  component: PriceListsList,
});
