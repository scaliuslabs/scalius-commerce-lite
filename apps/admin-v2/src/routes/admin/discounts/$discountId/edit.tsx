import { lazy, Suspense } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";

import type { Discount } from "~/types/api-responses";
import type { DiscountCollectionOption } from "~/components/admin/discount/CollectionSelector";
import type { DiscountProductOption } from "~/components/admin/discount/ProductSelector";
import {
  collectionsByIdsQueryOptions,
} from "~/lib/api-query-options/collections";
import { discountQueryOptions } from "~/lib/api-query-options/discounts";
import { productsByIdsQueryOptions } from "~/lib/api-query-options/products";
import { RouteErrorComponent } from "~/lib/route-error";
import { PageLoadingSkeleton } from "~/components/admin/shared/LoadingFallback";
import {
  normalizeBooleanSearchParam,
  type SearchValidatorInput,
} from "~/lib/list-helpers";

const DiscountCodeBuilder = lazy(() =>
  import("~/components/admin/discount/DiscountCodeBuilder").then((module) => ({
    default: module.DiscountCodeBuilder,
  })),
);

type DiscountEditSearchParams = {
  duplicate: boolean;
};

function validateDiscountEditSearch(
  search: SearchValidatorInput<DiscountEditSearchParams>,
): DiscountEditSearchParams {
  return { duplicate: normalizeBooleanSearchParam(search.duplicate) };
}

function uniqueRelationIds(relation?: { buy?: string[]; get?: string[] }): string[] {
  return Array.from(
    new Set([...(relation?.buy ?? []), ...(relation?.get ?? [])].filter(Boolean)),
  );
}

function isDiscountType(
  value: string,
): value is "amount_off_products" | "amount_off_order" | "free_shipping" {
  return ["amount_off_products", "amount_off_order", "free_shipping"].includes(value);
}

export const Route = createFileRoute("/admin/discounts/$discountId/edit")({
  validateSearch: validateDiscountEditSearch,
  loader: async ({ context: { queryClient }, params }) => {
    // Read failures stay on this route and use RouteErrorComponent. Redirecting
    // every failed request to the list made outages look like missing records.
    const discount = (await queryClient.ensureQueryData({
      ...discountQueryOptions(params.discountId),
      staleTime: Infinity,
    })) as Discount;

    if (discount.type === "amount_off_products" && typeof window !== "undefined") {
      const productIds = uniqueRelationIds(discount.relatedProducts);
      const collectionIds = uniqueRelationIds(discount.relatedCollections);
      if (productIds.length > 0) {
        void queryClient
          .prefetchQuery(productsByIdsQueryOptions(productIds))
          .catch((error) => console.warn("Discount product label prefetch skipped", error));
      }
      if (collectionIds.length > 0) {
        void queryClient
          .prefetchQuery(collectionsByIdsQueryOptions(collectionIds))
          .catch((error) => console.warn("Discount collection label prefetch skipped", error));
      }
    }
  },
  head: ({ match }) => ({
    meta: [
      {
        title: `${match.search.duplicate ? "Duplicate" : "Edit"} Discount | Scalius Admin`,
      },
    ],
  }),
  errorComponent: RouteErrorComponent,
  component: EditDiscountPage,
});

function EditDiscountPage() {
  const { discountId } = Route.useParams();
  const { duplicate } = Route.useSearch();
  const { data } = useSuspenseQuery(discountQueryOptions(discountId));
  const discount = data as Discount;

  const productIds = uniqueRelationIds(discount.relatedProducts);
  const collectionIds = uniqueRelationIds(discount.relatedCollections);
  const { data: productsData } = useQuery({
    ...productsByIdsQueryOptions(productIds),
    enabled: productIds.length > 0,
  });
  const { data: collectionsData } = useQuery({
    ...collectionsByIdsQueryOptions(collectionIds),
    enabled: collectionIds.length > 0,
  });

  if (!isDiscountType(discount.type)) {
    throw new Error("This discount type is not supported by the current editor.");
  }
  const productMap = new Map(
    (productsData?.products ?? []).map((product) => [product.id, product]),
  );
  const collectionMap = new Map(
    (collectionsData?.collections ?? []).map((collection) => [collection.id, collection]),
  );
  const selectedProducts: DiscountProductOption[] = productIds.map(
    (id) => productMap.get(id) ?? { id, name: id, price: 0 },
  );
  const selectedCollections: DiscountCollectionOption[] = collectionIds.map((id) => {
    const collection = collectionMap.get(id);
    return {
      id,
      name: collection?.name ?? id,
      description: null,
      slug: "",
      presentation: collection?.presentation,
    };
  });

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {duplicate ? "Duplicate discount" : "Edit discount"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {duplicate
              ? `Create a new draft using ${discount.code} as the starting rule.`
              : `Update ${discount.code}. Existing orders keep their saved totals.`}
          </p>
        </div>
        <Link
          to="/admin/discounts"
          className="inline-flex h-10 items-center justify-center rounded-md bg-secondary px-4 text-sm font-medium text-secondary-foreground ring-offset-background transition-colors hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Cancel
        </Link>
      </div>

      <Suspense fallback={<PageLoadingSkeleton />}>
        <DiscountCodeBuilder
          key={`${discount.id}:${duplicate ? "copy" : "edit"}`}
          type={discount.type}
          discountId={duplicate ? undefined : discount.id}
          discountRevision={duplicate ? undefined : discount.revision}
          defaultValues={{
            code: duplicate ? "" : discount.code,
            valueType: discount.valueType,
            discountValue: discount.discountValue,
            minPurchaseAmount: discount.minPurchaseAmount,
            minQuantity: discount.minQuantity,
            maxUses: discount.maxUses,
            limitOnePerCustomer: Boolean(discount.limitOnePerCustomer),
            startDate: discount.startDate,
            endDate: discount.endDate,
            isActive: duplicate ? false : Boolean(discount.isActive),
            appliesToProducts: productIds,
            appliesToCollections: collectionIds,
            maxUsesPerOrder: discount.maxUsesPerOrder,
            combineWithProductDiscounts: Boolean(discount.combineWithProductDiscounts),
            combineWithOrderDiscounts: Boolean(discount.combineWithOrderDiscounts),
            combineWithShippingDiscounts: Boolean(discount.combineWithShippingDiscounts),
            customerSegment: discount.customerSegment,
          }}
          initialSelectedProducts={selectedProducts}
          initialSelectedCollections={selectedCollections}
        />
      </Suspense>
    </>
  );
}
