import { createFileRoute } from "@tanstack/react-router";

import { DiscountEditor } from "~/components/admin/discounts/DiscountEditor";
import { DISCOUNT_TYPES, type DiscountType } from "~/components/admin/discounts/discount-form";
import { translate } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";

export const Route = createFileRoute("/admin/discounts/new")({
  validateSearch: (search: Record<string, unknown>): { type: DiscountType } => ({
    type: DISCOUNT_TYPES.find((type) => type === search.type) ?? "products",
  }),
  head: () => ({ meta: [{ title: `${translate(discountsMessages, "newTitle")} | Scalius Admin` }] }),
  component: NewDiscountPage,
});

function NewDiscountPage() {
  const { type } = Route.useSearch();
  // A different type is a different form: start it fresh.
  return <DiscountEditor key={type} type={type} />;
}
