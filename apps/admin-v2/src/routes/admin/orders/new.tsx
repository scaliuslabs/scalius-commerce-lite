import { createFileRoute } from "@tanstack/react-router";
import { OrderForm } from "~/components/admin/OrderForm";
import { deliveryLocationsQueryOptions } from "~/lib/api-query-options/delivery";
import { translate } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";
import { OrderFormRouteError } from "./-OrderFormRouteError";

export const Route = createFileRoute("/admin/orders/new")({
  // Products are searched inside the form; only delivery cities load up front.
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(deliveryLocationsQueryOptions({ type: "city" })),
  head: () => ({
    meta: [{ title: `${translate(orderFormMessages, "createOrder")} | Scalius` }],
  }),
  errorComponent: OrderFormRouteError,
  component: NewOrderPage,
});

function NewOrderPage() {
  return <OrderForm mode="create" />;
}
