import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CustomerForm } from "~/components/admin/CustomerForm";
import { customerQueryOptions } from "~/lib/api.queries";
import type { Customer } from "~/types/api-responses";

export const Route = createFileRoute("/admin/customers/$customerId/edit")({
  loader: async ({ context: { queryClient }, params }) => {
    const data = await queryClient.ensureQueryData({ ...customerQueryOptions(params.customerId), staleTime: Infinity }).catch(() => null);
    if (!data) throw redirect({ to: "/admin/customers" });
  },
  head: () => ({
    meta: [{ title: "Edit Customer | Scalius Admin" }],
  }),
  component: EditCustomerPage,
});

function EditCustomerPage() {
  const { customerId } = Route.useParams();
  const { data } = useSuspenseQuery(customerQueryOptions(customerId));
  const c = data as Customer;

  const customer = {
    ...c,
    cityName: c.cityName || "",
    zoneName: c.zoneName || "",
    areaName: c.areaName || "",
  };

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <CustomerForm defaultValues={customer} isEdit={true} />
    </div>
  );
}
