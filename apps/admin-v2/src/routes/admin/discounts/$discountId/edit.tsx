import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { z } from "zod";
import { AmountOffProductsForm } from "~/components/admin/discount/amount-off-products";
import { AmountOffOrderForm } from "~/components/admin/discount/AmountOffOrderForm";
import { FreeShippingForm } from "~/components/admin/discount/FreeShippingForm";
import { discountQueryOptions, collectionFormOptionsQueryOptions } from "~/lib/api.queries";
import type { Discount, CollectionFormOptionsData } from "~/types/api-responses";

const searchSchema = z.object({
  duplicate: z.boolean().default(false).catch(false),
});

export const Route = createFileRoute("/admin/discounts/$discountId/edit")({
  validateSearch: searchSchema,
  loader: async ({ context: { queryClient }, params }) => {
    const [discountResult] = await Promise.all([
      queryClient.ensureQueryData({ ...discountQueryOptions(params.discountId), staleTime: Infinity }).catch(() => null),
      queryClient.ensureQueryData(collectionFormOptionsQueryOptions()),
    ]);
    if (!discountResult) throw redirect({ to: "/admin/discounts" });
  },
  head: ({ match }) => ({
    meta: [{
      title: `${match.search.duplicate ? "Duplicate" : "Edit"} Discount | Scalius Admin`,
    }],
  }),
  component: EditDiscountPage,
});

function EditDiscountPage() {
  const { discountId } = Route.useParams();
  const { duplicate: isDuplicate } = Route.useSearch();
  const { data: discountResult } = useSuspenseQuery(discountQueryOptions(discountId));
  const { data: formOptions } = useSuspenseQuery(collectionFormOptionsQueryOptions());

  const discount = discountResult as Discount;
  const fo = formOptions as CollectionFormOptionsData;
  const allProducts = fo.products || [];
  const allProductIds = [
    ...(discount.relatedProducts?.buy || []),
    ...(discount.relatedProducts?.get || []),
  ];
  const selectedProducts = allProducts.filter((p) => allProductIds.includes(p.id));
  const allCollectionIds = [
    ...(discount.relatedCollections?.buy || []),
    ...(discount.relatedCollections?.get || []),
  ];
  const selectedCollections = allCollectionIds.map((colId: string) => ({
    id: colId, name: colId, description: null, slug: "",
  }));
  const formattedDiscount = {
    ...discount,
    startDate: discount.startDate ? new Date(discount.startDate) : new Date(),
    endDate: discount.endDate ? new Date(discount.endDate) : null,
  };

  if (!discount) {
    return <div>Discount not found</div>;
  }

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
        {discount.type === "amount_off_products" && (
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
              startDate: formattedDiscount.startDate,
              endDate: formattedDiscount.endDate,
              isActive: Boolean(discount.isActive),
            }}
            initialSelectedProducts={selectedProducts as Parameters<typeof AmountOffProductsForm>[0]["initialSelectedProducts"]}
            initialSelectedCollections={selectedCollections}
          />
        )}

        {discount.type === "amount_off_order" && (
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
              startDate: formattedDiscount.startDate,
              endDate: formattedDiscount.endDate,
              isActive: Boolean(discount.isActive),
            }}
          />
        )}

        {discount.type === "free_shipping" && (
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
              startDate: formattedDiscount.startDate,
              endDate: formattedDiscount.endDate,
              isActive: Boolean(discount.isActive),
            }}
          />
        )}
      </div>
    </>
  );
}
