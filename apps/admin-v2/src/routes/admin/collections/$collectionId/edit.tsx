import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CollectionForm } from "~/components/admin/collection-form";
import { collectionQueryOptions, collectionFormOptionsQueryOptions } from "~/lib/api.queries";
import type { Collection } from "~/types/api-responses";
import type { Category, Product } from "~/components/admin/collection-form/types";
import { RouteErrorComponent } from "~/lib/list-helpers";

export const Route = createFileRoute("/admin/collections/$collectionId/edit")({
  loader: async ({ params, context: { queryClient } }) => {
    const [collection] = await Promise.all([
      queryClient.ensureQueryData({ ...collectionQueryOptions(params.collectionId), staleTime: Infinity }).catch(() => null),
      queryClient.ensureQueryData(collectionFormOptionsQueryOptions()),
    ]);
    if (!collection) throw redirect({ to: "/admin/collections" });
  },
  head: () => ({ meta: [{ title: "Edit Collection | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: EditCollectionPage,
});

function EditCollectionPage() {
  const { collectionId } = Route.useParams();
  const { data: collectionData } = useSuspenseQuery(collectionQueryOptions(collectionId));
  const { data: formOptions } = useSuspenseQuery(collectionFormOptionsQueryOptions());

  const c = collectionData as Collection;
  const fo = formOptions as { categories?: Category[]; products?: Product[] };
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

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <CollectionForm
        categories={fo.categories || []}
        products={fo.products || []}
        defaultValues={{
          id: c.id,
          name: c.name,
          type: formType as "manual" | "dynamic",
          isActive: c.isActive,
          config,
        }}
        isEdit
      />
    </div>
  );
}
