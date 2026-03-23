import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { AmountOffProductsForm } from "~/components/admin/discount/amount-off-products";
import { AmountOffOrderForm } from "~/components/admin/discount/AmountOffOrderForm";
import { FreeShippingForm } from "~/components/admin/discount/FreeShippingForm";
import { getDiscount, getCollectionFormOptions } from "~/lib/api.functions";

const searchSchema = z.object({
  duplicate: z.boolean().default(false).catch(false),
});

export const Route = createFileRoute("/admin/discounts/$discountId/edit")({
  validateSearch: searchSchema,
  loader: async ({ params }) => {
    const [discountResult, formOptions] = await Promise.all([
      getDiscount({ data: { id: params.discountId } }).catch(() => null),
      getCollectionFormOptions().catch(() => ({ categories: [], products: [] })),
    ]);
    if (!discountResult) throw redirect({ to: "/admin/discounts" });
    const discount = discountResult as any;
    const fo = formOptions as any;
    const allProducts = fo.products || [];
    const allProductIds = [
      ...(discount.relatedProducts?.buy || []),
      ...(discount.relatedProducts?.get || []),
    ];
    const selectedProducts = allProducts.filter((p: any) => allProductIds.includes(p.id));
    const allCollectionIds = [
      ...(discount.relatedCollections?.buy || []),
      ...(discount.relatedCollections?.get || []),
    ];
    const selectedCollections = allCollectionIds.map((colId: string) => ({
      id: colId, name: colId, description: null, slug: "",
    }));
    return {
      discount,
      formattedDiscount: {
        ...discount,
        startDate: discount.startDate ? new Date(discount.startDate) : new Date(),
        endDate: discount.endDate ? new Date(discount.endDate) : null,
      },
      selectedProducts,
      selectedCollections,
    };
  },
  head: ({ loaderData, match }) => ({
    meta: [{
      title: `${(match.search as any).duplicate ? "Duplicate" : "Edit"} Discount | Scalius Admin`,
    }],
  }),
  component: EditDiscountPage,
});

function EditDiscountPage() {
  const { discount, formattedDiscount, selectedProducts, selectedCollections } = Route.useLoaderData();
  const { duplicate: isDuplicate } = Route.useSearch();

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
              valueType: discount.valueType,
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
            initialSelectedProducts={selectedProducts}
            initialSelectedCollections={selectedCollections}
          />
        )}

        {discount.type === "amount_off_order" && (
          <AmountOffOrderForm
            defaultValues={{
              id: effectiveId,
              code: effectiveCode,
              valueType: discount.valueType,
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
