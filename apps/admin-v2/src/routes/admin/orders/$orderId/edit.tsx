import { createFileRoute, redirect } from "@tanstack/react-router";
import { OrderForm } from "~/components/admin/OrderForm";
import { getOrderFormData } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/orders/$orderId/edit")({
  loader: async ({ params }) => {
    const result = await getOrderFormData({ data: { id: params.orderId } }).catch(() => null);
    if (!result) throw redirect({ to: "/admin/orders" });
    const r = result as any;
    return {
      order: { id: params.orderId },
      productsWithVariants: (r.productsWithVariants || []).map((p: any) => ({
        ...p,
        variants: (p.variants || []).map((v: any) => ({ ...v, sku: v.sku || "", price: v.price ?? 0 })),
      })),
      defaultValues: r.defaultValues || r,
    };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `Edit Order #${loaderData?.order?.id || ""} | Scalius Admin` }],
  }),
  component: EditOrderPage,
});

function EditOrderPage() {
  const { order, productsWithVariants, defaultValues } = Route.useLoaderData();

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <OrderForm
        products={productsWithVariants}
        defaultValues={defaultValues}
        isEdit={true}
      />
    </div>
  );
}
