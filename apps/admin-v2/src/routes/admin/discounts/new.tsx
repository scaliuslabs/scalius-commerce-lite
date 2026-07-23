import { lazy, Suspense } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DiscountTypeSelector } from "~/components/admin/discount/DiscountTypeSelector";
import { Button } from "~/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { PageLoadingSpinner } from "~/components/admin/shared/LoadingFallback";
import {
  discountEditorTypes,
  type DiscountEditorType,
} from "~/components/admin/discount/discount-editor-model";
import type { SearchValidatorInput } from "~/lib/list-helpers";

const DiscountCodeBuilder = lazy(
  () => import("~/components/admin/discount/DiscountCodeBuilder").then(m => ({ default: m.DiscountCodeBuilder })),
);

type DiscountCreateSearch = {
  type?: DiscountEditorType;
};

export function validateDiscountCreateSearch(
  search: SearchValidatorInput<DiscountCreateSearch>,
): DiscountCreateSearch {
  return {
    type: discountEditorTypes.includes(search.type as DiscountEditorType)
      ? (search.type as DiscountEditorType)
      : undefined,
  };
}

export const Route = createFileRoute("/admin/discounts/new")({
  validateSearch: validateDiscountCreateSearch,
  head: () => ({ meta: [{ title: "New Discount | Scalius Admin" }] }),
  component: NewDiscountPage,
});

function NewDiscountPage() {
  const selectedType = Route.useSearch().type;
  const navigate = useNavigate({ from: Route.fullPath });

  function selectType(type: DiscountEditorType | undefined) {
    void navigate({
      search: (previous) => ({ ...previous, type }),
      replace: Boolean(selectedType),
    });
  }

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Create discount</h1>
          {selectedType && (
            <p className="mt-1 text-sm text-muted-foreground">
              Set eligibility, limits, and dates before activation.
            </p>
          )}
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          {selectedType && (
            <Button className="min-h-10 flex-1 sm:flex-none" variant="outline" onClick={() => selectType(undefined)}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Change type
            </Button>
          )}
          <Link
            to="/admin/discounts"
            className="inline-flex h-10 flex-1 items-center justify-center rounded-md bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground ring-offset-background transition-colors hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:flex-none"
          >
            Cancel
          </Link>
        </div>
      </div>
      <div className="space-y-4">
        {!selectedType ? (
          <DiscountTypeSelector onSelect={selectType} />
        ) : (
          <Suspense fallback={<PageLoadingSpinner />}>
            <DiscountCodeBuilder
              key={selectedType}
              type={selectedType}
            />
          </Suspense>
        )}
      </div>
    </>
  );
}
