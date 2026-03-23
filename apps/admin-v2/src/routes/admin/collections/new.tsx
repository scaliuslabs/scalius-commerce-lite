import { createFileRoute } from "@tanstack/react-router";
import { CollectionForm } from "~/components/admin/collection-form";
import { getCollectionFormOptions } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/collections/new")({
  loader: async () => {
    const result = await getCollectionFormOptions();
    const r = result as any;
    return { allCategories: r.categories || [], allProducts: r.products || [] };
  },
  head: () => ({ meta: [{ title: "New Collection | Scalius Admin" }] }),
  component: NewCollectionPage,
});

function NewCollectionPage() {
  const { allCategories, allProducts } = Route.useLoaderData();

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <CollectionForm categories={allCategories} products={allProducts} />
    </div>
  );
}
