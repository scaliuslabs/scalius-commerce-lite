import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { CollectionForm } from "~/components/admin/collection-form";
import {
  collectionCategoryOptionsQueryOptions,
  collectionQueryOptions,
} from "~/lib/api-query-options/collections";
import { productsByIdsQueryOptions } from "~/lib/api-query-options/products";
import type { Category } from "~/components/admin/collection-form/types";
import { RouteErrorComponent } from "~/lib/route-error";
import {
  collectionProductIdsForLookup,
  normalizeCollectionConfig,
} from "@scalius/core/modules/collections/collection-config";
import { nullForAdminApiNotFound } from "~/lib/admin-api-error";

export const Route = createFileRoute("/admin/collections/$collectionId/edit")({
  loader: async ({ params, context: { queryClient } }) => {
    const [collection] = await Promise.all([
      queryClient
        .ensureQueryData({
          ...collectionQueryOptions(params.collectionId),
          staleTime: Infinity,
        })
        .catch(nullForAdminApiNotFound),
      queryClient.ensureQueryData(collectionCategoryOptionsQueryOptions()),
    ]);
    if (!collection) throw redirect({ to: "/admin/collections" });

    const productIds = collectionProductIdsForLookup(collection.config);
    if (typeof window !== "undefined" && productIds.length > 0) {
      void queryClient
        .prefetchQuery(productsByIdsQueryOptions(productIds))
        .catch((error) => {
          console.warn("Collection product label prefetch skipped", error);
        });
    }
  },
  head: () => ({ meta: [{ title: "Edit Collection | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: EditCollectionPage,
});

function EditCollectionPage() {
  const { collectionId } = Route.useParams();
  const { data: collectionData } = useSuspenseQuery(collectionQueryOptions(collectionId));
  const { data: formOptions } = useSuspenseQuery(collectionCategoryOptionsQueryOptions());

  const c = collectionData;
  const fo: { categories?: Category[] } = formOptions;
  const parsedConfig = normalizeCollectionConfig(c.config);
  const selectedProductIds = collectionProductIdsForLookup(parsedConfig);
  const config = {
    source: parsedConfig.source,
    categoryIds: parsedConfig.categoryIds,
    productIds: parsedConfig.productIds,
    featuredProductId: parsedConfig.featuredProductId,
    showOnHomepage: parsedConfig.showOnHomepage,
    maxProducts: parsedConfig.maxProducts,
    title: parsedConfig.title,
    subtitle: parsedConfig.subtitle,
  };
  const { data: productLookup } = useQuery({
    ...productsByIdsQueryOptions(selectedProductIds),
    enabled: selectedProductIds.length > 0,
  });
  return (
    <div className="container max-w-7xl py-4 pb-8">
      <CollectionForm
        categories={fo.categories || []}
        products={productLookup?.products ?? []}
        defaultValues={{
          id: c.id,
          version: c.version,
          name: c.name,
          presentation: c.presentation,
          isActive: c.isActive,
          canonicalPath: c.canonicalPath,
          noIndex: c.noIndex,
          excludeFromSitemap: c.excludeFromSitemap,
          config,
        }}
        isEdit
      />
    </div>
  );
}
