import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { BarcodeLabelWorkspace } from "~/components/admin/barcode-labels/BarcodeLabelWorkspace";
import {
  normalizeBarcodeLabelVariantIds,
  validateBarcodeLabelSearch,
} from "~/components/admin/barcode-labels/barcode-label-search";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/inventory/labels")({
  validateSearch: validateBarcodeLabelSearch,
  head: () => ({ meta: [{ title: "Barcode labels | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: BarcodeLabelPage,
});

function BarcodeLabelPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const selectedVariantIds = normalizeBarcodeLabelVariantIds(search.variants);
  const onSelectedVariantIdsChange = useCallback((variantIds: string[]) => {
    void navigate({
      to: "/admin/inventory/labels",
      search: variantIds.length > 0 ? { variants: variantIds.join(",") } : {},
      replace: true,
    });
  }, [navigate]);

  return (
    <BarcodeLabelWorkspace
      selectedVariantIds={selectedVariantIds}
      onSelectedVariantIdsChange={onSelectedVariantIdsChange}
    />
  );
}
