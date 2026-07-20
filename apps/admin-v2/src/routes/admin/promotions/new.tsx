import { createFileRoute } from "@tanstack/react-router";

import { PromotionBuilder } from "~/components/admin/promotion/PromotionBuilder";

export const Route = createFileRoute("/admin/promotions/new")({
  head: () => ({ meta: [{ title: "New Promotion | Scalius Admin" }] }),
  component: NewPromotionPage,
});

function NewPromotionPage() {
  return <PromotionBuilder />;
}
