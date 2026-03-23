import { createFileRoute } from "@tanstack/react-router";
import { ProductForm } from "~/components/admin/ProductForm";
import { getCategoryFormOptions } from "~/lib/api.functions";

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
  loader: async () => {
    const result = await getCategoryFormOptions();
    return { allCategories: (result as any).categories || [] };
  },
  head: () => ({ meta: [{ title: "New Product | Scalius Admin" }] }),
  component: NewProductPage,
});

function NewProductPage() {
  const { allCategories } = Route.useLoaderData();

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
