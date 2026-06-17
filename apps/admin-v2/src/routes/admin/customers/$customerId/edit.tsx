import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CustomerForm } from "~/components/admin/CustomerForm";
import { customerQueryOptions } from "~/lib/api-query-options/customers";
import type { CustomerFormValues } from "~/lib/form-schemas";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/customers/$customerId/edit")({
  loader: async ({ context: { queryClient }, params }) => {
    const data = await queryClient.ensureQueryData({ ...customerQueryOptions(params.customerId), staleTime: Infinity }).catch(() => null);
    if (!data) throw redirect({ to: "/admin/customers" });
  },
  head: () => ({
    meta: [{ title: "Edit Customer | Scalius Admin" }],
  }),
  errorComponent: RouteErrorComponent,
  component: EditCustomerPage,
});

function EditCustomerPage() {
  const { customerId } = Route.useParams();
  const { data } = useSuspenseQuery(customerQueryOptions(customerId));

  const customer = {
    id: data.id,
    name: data.name,
    email: data.email,
    phone: data.phone,
    address: data.address,
    city: data.city,
    zone: data.zone,
    area: data.area,
    cityName: data.cityName || "",
    zoneName: data.zoneName || "",
    areaName: data.areaName || "",
  } satisfies Partial<CustomerFormValues>;

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <CustomerForm defaultValues={customer} isEdit={true} />
    </div>
  );
}
