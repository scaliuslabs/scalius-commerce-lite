import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { PromotionBuilder } from "~/components/admin/promotion/PromotionBuilder";
import { promotionDetailQueryOptions } from "~/lib/api-query-options/promotions";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/promotions/$promotionId/edit")({
  loader: async ({ context: { queryClient }, params }) => {
    await queryClient.ensureQueryData(
      promotionDetailQueryOptions(params.promotionId),
    );
  },
  head: () => ({ meta: [{ title: "Edit Promotion | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: EditPromotionPage,
});

function EditPromotionPage() {
  const { promotionId } = Route.useParams();
  const { data: promotion } = useSuspenseQuery(
    promotionDetailQueryOptions(promotionId),
  );
  if (promotion.method !== "code") {
    throw new Error("Automatic promotions are not available in this editor.");
  }
  return <PromotionBuilder key={`${promotion.id}:${promotion.revision}`} promotion={promotion} />;
}
