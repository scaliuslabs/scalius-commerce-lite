import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CustomerHistoryView } from "~/components/admin/CustomerHistoryView";
import { customerHistoryQueryOptions } from "~/lib/api.queries";
import { RouteErrorComponent } from "~/lib/list-helpers";

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
  const r = data as Record<string, unknown>;

  return (
    <CustomerHistoryView
      customer={r.customer as Parameters<typeof CustomerHistoryView>[0]["customer"]}
      history={(r.history || []) as Parameters<typeof CustomerHistoryView>[0]["history"]}
      orders={(r.orders || []) as Parameters<typeof CustomerHistoryView>[0]["orders"]}
    />
  );
}
