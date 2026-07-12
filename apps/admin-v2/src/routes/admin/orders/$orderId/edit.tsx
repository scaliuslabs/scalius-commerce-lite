import { createFileRoute } from "@tanstack/react-router";
import { OrderForm } from "~/components/admin/OrderForm";
import { orderFormDataQueryOptions } from "~/lib/api-query-options/orders";
import { deliveryLocationsQueryOptions } from "~/lib/api-query-options/delivery";
import { OrderFormRouteError } from "../-OrderFormRouteError";
import {
  assertOrderFormLocationLookup,
  buildEditOrderFormRouteData,
} from "../-order-form-route-state";

export const Route = createFileRoute("/admin/orders/$orderId/edit")({
  loader: async ({ context: { queryClient }, params }) => {
    const result = await queryClient.ensureQueryData({
      ...orderFormDataQueryOptions(params.orderId),
      staleTime: Infinity,
    });
    const locations = await queryClient.ensureQueryData(
      deliveryLocationsQueryOptions({ type: "city" }),
    );
    assertOrderFormLocationLookup(locations);
    return buildEditOrderFormRouteData(result);
  },
  head: ({ params }) => ({
    meta: [{ title: `Edit Order #${params.orderId} | Scalius Admin` }],
  }),
  errorComponent: EditOrderFormErrorComponent,
  component: EditOrderPage,
});

function EditOrderFormErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <OrderFormRouteError
      title="Order editor could not be loaded"
      description="Required order form, product, or delivery-location data is unavailable. The order was not changed."
      error={error}
      reset={reset}
    />
  );
}

function EditOrderPage() {
  const r = Route.useLoaderData();

  const productsWithVariants = r.productsWithVariants.map((p) => ({
    ...p,
    variants: p.variants.map((v) => ({ ...v, sku: v.sku || "", price: v.price ?? 0 })),
  }));

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <OrderForm
        products={productsWithVariants}
        defaultValues={r.defaultValues}
        isEdit={true}
      />
    </div>
  );
}
