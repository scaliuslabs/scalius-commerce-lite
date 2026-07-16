import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { BarcodeLabelWorkspace } from "~/components/admin/barcode-labels/BarcodeLabelWorkspace";
import { MAX_LABEL_SKUS } from "~/components/admin/barcode-labels/barcode-label-model";
import { RouteErrorComponent } from "~/lib/route-error";

type LabelSearch = {
  variants?: string;
};

function normalizeVariantIds(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return Array.from(new Set(
    value.split(",").map((id) => id.trim()).filter((id) => /^var_[A-Za-z0-9_-]+$/.test(id)),
  )).slice(0, MAX_LABEL_SKUS);
}

export function validateBarcodeLabelSearch(search: Record<string, unknown>): LabelSearch {
  const variants = normalizeVariantIds(search.variants);
  return variants.length > 0 ? { variants: variants.join(",") } : {};
}

export const Route = createFileRoute("/admin/inventory/labels")({
  validateSearch: validateBarcodeLabelSearch,
  head: () => ({ meta: [{ title: "Barcode labels | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: BarcodeLabelPage,
});

function BarcodeLabelPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const selectedVariantIds = normalizeVariantIds(search.variants);
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
