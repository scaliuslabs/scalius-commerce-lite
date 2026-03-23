import { createFileRoute, redirect } from "@tanstack/react-router";
import { CollectionForm } from "~/components/admin/collection-form";
import { getCollection, getCollectionFormOptions } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/collections/$collectionId/edit")({
  loader: async ({ params }) => {
    const [collection, formOptions] = await Promise.all([
      getCollection({ data: { id: params.collectionId } }).catch(() => null),
      getCollectionFormOptions(),
    ]);
    if (!collection) throw redirect({ to: "/admin/collections" });
    const c = collection as any;
    const fo = formOptions as any;
    const parsedConfig = typeof c.config === "string" ? JSON.parse(c.config) : c.config || {};
    const config = {
      categoryIds: parsedConfig.categoryIds || [],
      productIds: parsedConfig.productIds || parsedConfig.specificProductIds || [],
      featuredProductId: parsedConfig.featuredProductId,
      maxProducts: parsedConfig.maxProducts || 8,
      title: parsedConfig.title || "",
      subtitle: parsedConfig.subtitle || "",
    };
    const validTypes = ["manual", "dynamic"];
    const formType = validTypes.includes(c.type) ? c.type : "manual";
    return {
      allCategories: fo.categories || [],
      allProducts: fo.products || [],
      defaultValues: {
        id: c.id,
        name: c.name,
        type: formType as "manual" | "dynamic",
        isActive: c.isActive,
        config,
      },
    };
  },
  head: () => ({ meta: [{ title: "Edit Collection | Scalius Admin" }] }),
  component: EditCollectionPage,
});

function EditCollectionPage() {
  const { allCategories, allProducts, defaultValues } = Route.useLoaderData();

  if (!defaultValues) {
    return <div>Collection not found</div>;
  }

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <CollectionForm
        categories={allCategories}
        products={allProducts}
        defaultValues={defaultValues}
        isEdit
      />
    </div>
  );
}
