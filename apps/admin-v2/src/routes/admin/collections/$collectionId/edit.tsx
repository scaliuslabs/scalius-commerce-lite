import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { CollectionForm } from "~/components/admin/collection-form";
import {
  collectionCategoryOptionsQueryOptions,
  collectionQueryOptions,
} from "~/lib/api-query-options/collections";
import { productsByIdsQueryOptions } from "~/lib/api-query-options/products";
import type { Category, Product } from "~/components/admin/collection-form/types";
import { RouteErrorComponent } from "~/lib/route-error";
import type { CollectionDto } from "~/lib/api-functions/collections";

interface CollectionConfig {
  categoryIds: string[];
  productIds: string[];
  specificProductIds?: string[];
  featuredProductId?: string;
  maxProducts?: number;
  title?: string;
  subtitle?: string;
}

function parseCollectionConfig(config: CollectionDto["config"]): CollectionConfig {
  if (typeof config === "string") {
    try {
      return JSON.parse(config) as CollectionConfig;
    } catch {
      return { categoryIds: [], productIds: [] };
    }
  }
  return (config || { categoryIds: [], productIds: [] }) as CollectionConfig;
}

function productIdsFromConfig(config: CollectionConfig): string[] {
  return Array.from(new Set([
    ...(config.productIds || config.specificProductIds || []),
    ...(config.featuredProductId ? [config.featuredProductId] : []),
  ].filter(Boolean)));
}

export const Route = createFileRoute("/admin/collections/$collectionId/edit")({
  loader: async ({ params, context: { queryClient } }) => {
    const [collection] = await Promise.all([
      queryClient.ensureQueryData({ ...collectionQueryOptions(params.collectionId), staleTime: Infinity }).catch(() => null),
      queryClient.ensureQueryData(collectionCategoryOptionsQueryOptions()),
    ]);
    if (!collection) throw redirect({ to: "/admin/collections" });

    const productIds = productIdsFromConfig(parseCollectionConfig(collection.config));
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
  const parsedConfig = parseCollectionConfig(c.config);
  const selectedProductIds = productIdsFromConfig(parsedConfig);
  const config = {
    categoryIds: parsedConfig.categoryIds || [],
    productIds: parsedConfig.productIds || parsedConfig.specificProductIds || [],
    featuredProductId: parsedConfig.featuredProductId,
    maxProducts: parsedConfig.maxProducts || 8,
    title: parsedConfig.title || "",
    subtitle: parsedConfig.subtitle || "",
  };
  const { data: productLookup } = useQuery({
    ...productsByIdsQueryOptions(selectedProductIds),
    enabled: selectedProductIds.length > 0,
  });
  const validTypes = ["manual", "dynamic"];
  const formType = validTypes.includes(c.type) ? c.type : "manual";

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <CollectionForm
        categories={fo.categories || []}
        products={(productLookup as { products?: Product[] }).products || []}
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
