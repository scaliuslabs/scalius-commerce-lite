import { createFileRoute } from "@tanstack/react-router";
import { OrderForm } from "~/components/admin/OrderForm";
import { productsQueryOptions } from "~/lib/api-query-options/products";
import { deliveryLocationsQueryOptions } from "~/lib/api-query-options/delivery";
import { OrderFormRouteError } from "./-OrderFormRouteError";
import {
  assertOrderFormLocationLookup,
  buildNewOrderFormRouteData,
} from "./-order-form-route-state";

const defaultValues = {
  customerName: "",
  customerPhone: "",
  customerEmail: null,
  shippingAddress: "",
  city: "",
  zone: "",
  area: null,
  notes: null,
  items: [],
  discountAmount: null,
  shippingCharge: 0,
};

export const Route = createFileRoute("/admin/orders/new")({
  loader: async ({ context: { queryClient } }) => {
    const result = await queryClient.ensureQueryData(
      productsQueryOptions({ page: 1, limit: 100 }),
    );
    const locations = await queryClient.ensureQueryData(
      deliveryLocationsQueryOptions({ type: "city" }),
    );
    assertOrderFormLocationLookup(locations);
    return buildNewOrderFormRouteData(result);
  },
  head: () => ({ meta: [{ title: "New Order | Scalius Admin" }] }),
  errorComponent: NewOrderFormErrorComponent,
  component: NewOrderPage,
});

function NewOrderFormErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <OrderFormRouteError
      title="New order form could not be loaded"
      description="Required product or delivery-location data is unavailable. No empty catalog was substituted."
      error={error}
      reset={reset}
    />
  );
}

function NewOrderPage() {
  const { productsWithVariants } = Route.useLoaderData();

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <OrderForm
        products={productsWithVariants}
        defaultValues={defaultValues}
        isEdit={false}
      />
    </div>
  );
}
