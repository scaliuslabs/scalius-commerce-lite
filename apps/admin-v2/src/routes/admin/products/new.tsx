import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ProductForm } from "~/components/admin/ProductForm";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import type { Category } from "~/components/admin/product-form/types";
import { RouteErrorComponent } from "~/lib/route-error";

const defaultValues = {
  name: "",
  description: null,
  price: 0,
  categoryId: "",
  isActive: true,
  discountType: "percentage" as "percentage" | "flat",
  discountPercentage: 0,
  discountAmount: 0,
  freeDelivery: false,
  metaTitle: null,
  metaDescription: null,
  slug: "",
  images: [],
};

export const Route = createFileRoute("/admin/products/new")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(categoryFormOptionsQueryOptions());
  },
  head: () => ({ meta: [{ title: "New Product | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: NewProductPage,
});

function NewProductPage() {
  const { data: categoryData } = useSuspenseQuery(categoryFormOptionsQueryOptions());
  const allCategories = categoryData.categories as Category[];

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <ProductForm
        categories={allCategories}
        defaultValues={defaultValues}
        isEdit={false}
      />
    </div>
  );
}
