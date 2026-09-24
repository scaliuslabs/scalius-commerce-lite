import { createFileRoute } from "@tanstack/react-router";
import { OrderForm } from "~/components/admin/OrderForm";
import { translate } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";
import { OrderFormRouteError } from "./-OrderFormRouteError";

export const Route = createFileRoute("/admin/orders/new")({
  // Products and delivery places are searched inside the form; nothing loads up front.
  head: () => ({
    meta: [{ title: `${translate(orderFormMessages, "createOrder")} | Scalius` }],
  }),
  errorComponent: OrderFormRouteError,
  component: NewOrderPage,
});

function NewOrderPage() {
  return <OrderForm mode="create" />;
}
