import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CustomerHistoryView } from "~/components/admin/CustomerHistoryView";
import { customerHistoryQueryOptions } from "~/lib/api-query-options/customers";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/customers/$customerId/history")({
  loader: async ({ context: { queryClient }, params }) => {
    const data = await queryClient.ensureQueryData({ ...customerHistoryQueryOptions(params.customerId), staleTime: Infinity }).catch(() => null);
    if (!data) throw redirect({ to: "/admin/customers" });
  },
  head: () => ({
    meta: [{ title: "Customer History | Scalius Admin" }],
  }),
  errorComponent: RouteErrorComponent,
  component: CustomerHistoryPage,
});

function CustomerHistoryPage() {
  const { customerId } = Route.useParams();
  const { data } = useSuspenseQuery(customerHistoryQueryOptions(customerId));

  return (
    <CustomerHistoryView
      customer={data.customer}
      history={data.history}
      orders={data.orders}
    />
  );
}
