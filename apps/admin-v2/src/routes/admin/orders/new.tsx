import { createFileRoute } from "@tanstack/react-router";
import { OrderForm } from "~/components/admin/OrderForm";
import { OrderFormRouteError } from "./-OrderFormRouteError";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/orders/new")({
  // Products and delivery places are searched inside the form; nothing loads up front.
  head: () => pageHead("createOrder"),
  errorComponent: OrderFormRouteError,
  component: NewOrderPage,
});

function NewOrderPage() {
  return <OrderForm mode="create" />;
}
