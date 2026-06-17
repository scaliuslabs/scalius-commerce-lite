import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { OrderForm } from "~/components/admin/OrderForm";
import { orderFormDataQueryOptions } from "~/lib/api-query-options/orders";
import type { ProductVariant } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/route-error";

interface OrderFormProduct {
  id: string;
  name: string;
  price: number;
  discountPercentage: number | null;
  variants: ProductVariant[];
}

interface OrderFormDataResult {
  productsWithVariants?: OrderFormProduct[];
  defaultValues?: Record<string, unknown>;
}

export const Route = createFileRoute("/admin/orders/$orderId/edit")({
  loader: async ({ context: { queryClient }, params }) => {
    try {
      await queryClient.ensureQueryData({ ...orderFormDataQueryOptions(params.orderId), staleTime: Infinity });
    } catch {
      throw redirect({ to: "/admin/orders" });
    }
  },
  head: ({ params }) => ({
    meta: [{ title: `Edit Order #${params.orderId} | Scalius Admin` }],
  }),
  errorComponent: RouteErrorComponent,
  component: EditOrderPage,
});

function EditOrderPage() {
  const { orderId } = Route.useParams();
  const { data } = useSuspenseQuery(orderFormDataQueryOptions(orderId));
  const r = data as OrderFormDataResult;

  const productsWithVariants = (r.productsWithVariants || []).map((p) => ({
    ...p,
    variants: (p.variants || []).map((v) => ({ ...v, sku: v.sku || "", price: v.price ?? 0 })),
  }));

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <OrderForm
        products={productsWithVariants}
        defaultValues={(r.defaultValues || r) as Record<string, unknown>}
        isEdit={true}
      />
    </div>
  );
}
