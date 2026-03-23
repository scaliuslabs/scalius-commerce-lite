import { createFileRoute, Link } from "@tanstack/react-router";
import { DiscountTypeSelector } from "~/components/admin/discount/DiscountTypeSelector";

export const Route = createFileRoute("/admin/discounts/new")({
  head: () => ({ meta: [{ title: "New Discount | Scalius Admin" }] }),
  component: NewDiscountPage,
});

function NewDiscountPage() {
  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Create New Discount</h1>
          <p className="text-muted-foreground">
            Choose a discount type and fill in the details
          </p>
        </div>
        <Link
          to="/admin/discounts"
          className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 bg-secondary text-secondary-foreground hover:bg-secondary/80 h-10 px-4 py-2"
        >
          Cancel
        </Link>
      </div>
      <div className="space-y-8">
        <DiscountTypeSelector />
      </div>
    </>
  );
}
