import { lazy, Suspense } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  collectionsByIdsQueryOptions,
} from "~/lib/api-query-options/collections";
import {
  discountQueryOptions,
} from "~/lib/api-query-options/discounts";
import {
  productsByIdsQueryOptions,
} from "~/lib/api-query-options/products";
import type { Discount } from "~/types/api-responses";
import type { Product, Collection } from "~/components/admin/discount/amount-off-products/types";
import { RouteErrorComponent } from "~/lib/route-error";
import { PageLoadingSpinner } from "~/components/admin/shared/LoadingFallback";
import {
  normalizeBooleanSearchParam,
  type SearchValidatorInput,
} from "~/lib/list-helpers";

const AmountOffProductsForm = lazy(
  () =>
    import("~/components/admin/discount/amount-off-products/AmountOffProductsContainer").then((m) => ({
      default: m.AmountOffProductsContainer,
    })),
);
const AmountOffOrderForm = lazy(
  () =>
    import("~/components/admin/discount/AmountOffOrderForm").then((m) => ({
      default: m.AmountOffOrderForm,
    })),
);
const FreeShippingForm = lazy(
  () =>
    import("~/components/admin/discount/FreeShippingForm").then((m) => ({
      default: m.FreeShippingForm,
    })),
);

type DiscountEditSearchParams = {
  duplicate: boolean;
};

function validateDiscountEditSearch(
  search: SearchValidatorInput<DiscountEditSearchParams>,
): DiscountEditSearchParams {
  return {
    duplicate: normalizeBooleanSearchParam(search.duplicate),
  };
}

function getDiscountProductIds(discount: Discount): string[] {
  return Array.from(new Set([
    ...(discount.relatedProducts?.buy || []),
    ...(discount.relatedProducts?.get || []),
  ].filter(Boolean)));
}

function getDiscountCollectionIds(discount: Discount): string[] {
  return Array.from(new Set([
    ...(discount.relatedCollections?.buy || []),
    ...(discount.relatedCollections?.get || []),
  ].filter(Boolean)));
}

export const Route = createFileRoute("/admin/discounts/$discountId/edit")({
  validateSearch: validateDiscountEditSearch,
  loader: async ({ context: { queryClient }, params }) => {
    const discountResult = await queryClient
      .ensureQueryData({ ...discountQueryOptions(params.discountId), staleTime: Infinity })
      .catch(() => null);
    if (!discountResult) throw redirect({ to: "/admin/discounts" });

    const discount = discountResult as Discount;
    if (discount.type === "amount_off_products") {
      const productIds = getDiscountProductIds(discount);
      const collectionIds = getDiscountCollectionIds(discount);
      if (typeof window !== "undefined") {
        if (productIds.length > 0) {
          void queryClient
            .prefetchQuery(productsByIdsQueryOptions(productIds))
            .catch((error) => {
              console.warn("Discount product label prefetch skipped", error);
            });
        }
        if (collectionIds.length > 0) {
          void queryClient
            .prefetchQuery(collectionsByIdsQueryOptions(collectionIds))
            .catch((error) => {
              console.warn("Discount collection label prefetch skipped", error);
            });
        }
      }
    }
  },
  head: ({ match }) => ({
    meta: [{
      title: `${match.search.duplicate ? "Duplicate" : "Edit"} Discount | Scalius Admin`,
    }],
  }),
  errorComponent: RouteErrorComponent,
  component: EditDiscountPage,
});

function EditDiscountPage() {
  const { discountId } = Route.useParams();
  const { duplicate: isDuplicate } = Route.useSearch();
  const { data: discountResult } = useSuspenseQuery(discountQueryOptions(discountId));
  const discount = discountResult as Discount;
  const formattedDiscount = {
    ...discount,
    startDate: discount.startDate ? new Date(discount.startDate) : new Date(),
    endDate: discount.endDate ? new Date(discount.endDate) : null,
  };

  const pageTitle = isDuplicate ? "Duplicate Discount" : "Edit Discount";
  const pageDescription = isDuplicate
    ? `Creating a copy of "${discount.code}"`
    : `Modify the discount "${discount.code}"`;

  const effectiveId = isDuplicate ? undefined : discount.id;
  const effectiveCode = isDuplicate ? "" : discount.code;

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{pageTitle}</h1>
          <p className="text-muted-foreground">{pageDescription}</p>
        </div>
        <Link
          to="/admin/discounts"
          className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 bg-secondary text-secondary-foreground hover:bg-secondary/80 h-10 px-4 py-2"
        >
          Cancel
        </Link>
      </div>

      <div>
        <Suspense fallback={<PageLoadingSpinner />}>
          {discount.type === "amount_off_products" && (
            <AmountOffProductsEditor
              discount={discount}
              effectiveId={effectiveId}
              effectiveCode={effectiveCode}
              startDate={formattedDiscount.startDate}
              endDate={formattedDiscount.endDate}
            />
          )}

          {discount.type === "amount_off_order" && (
            <AmountOffOrderEditor
              discount={discount}
              effectiveId={effectiveId}
              effectiveCode={effectiveCode}
              startDate={formattedDiscount.startDate}
              endDate={formattedDiscount.endDate}
            />
          )}

          {discount.type === "free_shipping" && (
            <FreeShippingEditor
              discount={discount}
              effectiveId={effectiveId}
              effectiveCode={effectiveCode}
              startDate={formattedDiscount.startDate}
              endDate={formattedDiscount.endDate}
            />
          )}
        </Suspense>
      </div>
    </>
  );
}

interface DiscountEditorProps {
  discount: Discount;
  effectiveId?: string;
  effectiveCode: string;
  startDate: Date;
  endDate: Date | null;
}

function AmountOffProductsEditor({
  discount,
  effectiveId,
  effectiveCode,
  startDate,
  endDate,
}: DiscountEditorProps) {
  const allProductIds = getDiscountProductIds(discount);
  const allCollectionIds = getDiscountCollectionIds(discount);
  const { data: productsData } = useQuery({
    ...productsByIdsQueryOptions(allProductIds),
    enabled: allProductIds.length > 0,
  });
  const { data: collectionsData } = useQuery({
    ...collectionsByIdsQueryOptions(allCollectionIds),
    enabled: allCollectionIds.length > 0,
  });
  const productsMap = new Map(
    ((productsData as { products?: Product[] }).products || []).map((product) => [
      product.id,
      product,
    ]),
  );
  const selectedProducts = allProductIds.map(
    (productId) => productsMap.get(productId) ?? { id: productId, name: productId, price: 0 },
  );
  const collectionsMap = new Map(
    ((collectionsData as { collections?: Array<{ id: string; name: string; type?: string }> })
      .collections || []).map((collection) => [collection.id, collection]),
  );
  const selectedCollections: Collection[] = allCollectionIds.map((collectionId: string) => {
    const found = collectionsMap.get(collectionId);
    return {
      id: collectionId,
      name: found?.name || collectionId,
      description: null,
      slug: "",
      type: (found?.type as "manual" | "dynamic") || undefined,
    };
  });

  return (
    <AmountOffProductsForm
      defaultValues={{
        id: effectiveId,
        code: effectiveCode,
        valueType: discount.valueType as "percentage" | "fixed_amount",
        discountValue: discount.discountValue,
        minPurchaseAmount: discount.minPurchaseAmount,
        minQuantity: discount.minQuantity,
        maxUsesPerOrder: discount.maxUsesPerOrder,
        maxUses: discount.maxUses,
        limitOnePerCustomer: Boolean(discount.limitOnePerCustomer),
        combineWithProductDiscounts: Boolean(discount.combineWithProductDiscounts),
        combineWithOrderDiscounts: Boolean(discount.combineWithOrderDiscounts),
        combineWithShippingDiscounts: Boolean(discount.combineWithShippingDiscounts),
        startDate,
        endDate,
        isActive: Boolean(discount.isActive),
      }}
      initialSelectedProducts={selectedProducts}
      initialSelectedCollections={selectedCollections}
    />
  );
}

function AmountOffOrderEditor({
  discount,
  effectiveId,
  effectiveCode,
  startDate,
  endDate,
}: DiscountEditorProps) {
  return (
    <AmountOffOrderForm
      defaultValues={{
        id: effectiveId,
        code: effectiveCode,
        valueType: discount.valueType as "percentage" | "fixed_amount",
        discountValue: discount.discountValue,
        minPurchaseAmount: discount.minPurchaseAmount,
        maxUsesPerOrder: discount.maxUsesPerOrder,
        maxUses: discount.maxUses,
        limitOnePerCustomer: Boolean(discount.limitOnePerCustomer),
        combineWithProductDiscounts: Boolean(discount.combineWithProductDiscounts),
        combineWithShippingDiscounts: Boolean(discount.combineWithShippingDiscounts),
        startDate,
        endDate,
        isActive: Boolean(discount.isActive),
      }}
    />
  );
}

function FreeShippingEditor({
  discount,
  effectiveId,
  effectiveCode,
  startDate,
  endDate,
}: DiscountEditorProps) {
  return (
    <FreeShippingForm
      defaultValues={{
        id: effectiveId,
        code: effectiveCode,
        minPurchaseAmount: discount.minPurchaseAmount,
        maxUsesPerOrder: discount.maxUsesPerOrder,
        maxUses: discount.maxUses,
        limitOnePerCustomer: Boolean(discount.limitOnePerCustomer),
        combineWithProductDiscounts: Boolean(discount.combineWithProductDiscounts),
        combineWithOrderDiscounts: Boolean(discount.combineWithOrderDiscounts),
        startDate,
        endDate,
        isActive: Boolean(discount.isActive),
      }}
    />
  );
}
