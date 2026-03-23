import { createFileRoute, redirect } from "@tanstack/react-router";
import { CustomerHistoryView } from "~/components/admin/CustomerHistoryView";
import { getCustomerHistory } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/customers/$customerId/history")({
  loader: async ({ params }) => {
    const result = await getCustomerHistory({ data: { id: params.customerId } }).catch(() => null);
    if (!result) throw redirect({ to: "/admin/customers" });
    const r = result as any;
    return {
      customer: r.customer || null,
      history: r.history || [],
      orders: r.orders || [],
    };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `Customer History - ${loaderData?.customer?.name || "Customer"} | Scalius Admin` }],
  }),
  component: CustomerHistoryPage,
});

function CustomerHistoryPage() {
  const { customer, history, orders } = Route.useLoaderData();

  if (!customer) {
    return <div>Customer not found</div>;
  }

  return (
    <CustomerHistoryView
      customer={customer}
      history={history}
      orders={orders}
    />
  );
}
