import { useState, lazy, Suspense } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DiscountTypeSelector } from "~/components/admin/discount/DiscountTypeSelector";
import { Button } from "~/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { PageLoadingSpinner } from "~/components/admin/shared/LoadingFallback";

const AmountOffProductsContainer = lazy(
  () => import("~/components/admin/discount/amount-off-products/AmountOffProductsContainer").then(m => ({ default: m.AmountOffProductsContainer })),
);
const AmountOffOrderForm = lazy(
  () => import("~/components/admin/discount/AmountOffOrderForm").then(m => ({ default: m.AmountOffOrderForm })),
);
const FreeShippingForm = lazy(
  () => import("~/components/admin/discount/FreeShippingForm").then(m => ({ default: m.FreeShippingForm })),
);

export const Route = createFileRoute("/admin/discounts/new")({
  head: () => ({ meta: [{ title: "New Discount | Scalius Admin" }] }),
  component: NewDiscountPage,
});

function NewDiscountPage() {
  const [selectedType, setSelectedType] = useState<string | null>(null);

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Create New Discount</h1>
          <p className="text-muted-foreground">
            {selectedType
              ? "Fill in the details for your discount"
              : "Choose a discount type and fill in the details"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selectedType && (
            <Button variant="outline" onClick={() => setSelectedType(null)}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Change Type
            </Button>
          )}
          <Link
            to="/admin/discounts"
            className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 bg-secondary text-secondary-foreground hover:bg-secondary/80 h-10 px-4 py-2"
          >
            Cancel
          </Link>
        </div>
      </div>
      <div className="space-y-8">
        {!selectedType ? (
          <DiscountTypeSelector onSelect={setSelectedType} />
        ) : (
          <Suspense fallback={<PageLoadingSpinner />}>
            {selectedType === "amount_off_products" && <AmountOffProductsContainer />}
            {selectedType === "amount_off_order" && <AmountOffOrderForm />}
            {selectedType === "free_shipping" && <FreeShippingForm />}
          </Suspense>
        )}
      </div>
    </>
  );
}
