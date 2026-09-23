import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { DiscountEditor } from "~/components/admin/discounts/DiscountEditor";
import { discountTypeOf } from "~/components/admin/discounts/discount-form";
import { translate } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";
import { discountQueryOptions } from "~/lib/api-query-options/discounts";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/discounts/$discountId")({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(discountQueryOptions(params.discountId)),
  head: () => ({ meta: [{ title: `${translate(discountsMessages, "pageTitle")} | Scalius Admin` }] }),
  errorComponent: RouteErrorComponent,
  component: DiscountPage,
});

function DiscountPage() {
  const { discountId } = Route.useParams();
  const { data: discount } = useSuspenseQuery(discountQueryOptions(discountId));
  return <DiscountEditor key={discount.id} type={discountTypeOf(discount)} discount={discount} />;
}
