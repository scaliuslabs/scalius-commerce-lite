import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { OrderForm } from "~/components/admin/OrderForm";
import { customerQueryOptions } from "~/lib/api-query-options/customers";
import { OrderFormRouteError } from "./-OrderFormRouteError";
import { pageHead } from "~/i18n/page-titles";

/** `?customerId=` (the customer page's Create order): the order starts with that customer's contact. */
const CUSTOMER_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const Route = createFileRoute("/admin/orders/new")({
  validateSearch: (search: Record<string, unknown>): { customerId?: string } =>
    typeof search.customerId === "string" && CUSTOMER_ID.test(search.customerId) ? { customerId: search.customerId } : {},
  loaderDeps: ({ search }) => ({ customerId: search.customerId }),
  // Products and delivery places are searched inside the form; only a chosen customer loads up front.
  loader: ({ context: { queryClient }, deps }) =>
    deps.customerId ? queryClient.ensureQueryData(customerQueryOptions(deps.customerId)).catch(() => null) : null,
  head: () => pageHead("createOrder"),
  errorComponent: OrderFormRouteError,
  component: NewOrderPage,
});

function NewOrderPage() {
  const { customerId } = Route.useSearch();
  const customer = useQuery({ ...customerQueryOptions(customerId ?? ""), enabled: Boolean(customerId) });
  if (customerId && customer.isPending) return null;
  const data = customer.data;
  // A customer that can't be read starts a blank order rather than blocking it.
  return (
    <OrderForm
      key={data?.id ?? "blank"}
      mode="create"
      defaultValues={data ? { customerName: data.name, customerPhone: data.phone ?? "", customerEmail: data.email } : undefined}
    />
  );
}
