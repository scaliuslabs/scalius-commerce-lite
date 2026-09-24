import { createFileRoute } from "@tanstack/react-router";

import { DiscountEditor } from "~/components/admin/discounts/DiscountEditor";
import { DISCOUNT_TYPES, type DiscountType } from "~/components/admin/discounts/discount-kinds";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/discounts/new")({
  validateSearch: (search: Record<string, unknown>): { type: DiscountType } => ({
    type: DISCOUNT_TYPES.find((type) => type === search.type) ?? "products",
  }),
  head: () => pageHead("createDiscount"),
  component: NewDiscountPage,
});

function NewDiscountPage() {
  const { type } = Route.useSearch();
  // A different type is a different form: start it fresh.
  return <DiscountEditor key={type} type={type} />;
}
