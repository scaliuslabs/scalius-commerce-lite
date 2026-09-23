import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CustomerForm } from "~/components/admin/CustomerForm";
import { customerQueryOptions } from "~/lib/api-query-options/customers";
import { RouteErrorComponent } from "~/lib/route-error";
import { translate } from "~/i18n";
import { customersMessages } from "~/i18n/customers";

export const Route = createFileRoute("/admin/customers/$customerId/edit")({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData({ ...customerQueryOptions(params.customerId), staleTime: Infinity }),
  head: () => ({ meta: [{ title: translate(customersMessages, "customer") }] }),
  errorComponent: RouteErrorComponent,
  component: CustomerPage,
});

function CustomerPage() {
  const { customerId } = Route.useParams();
  const { data } = useSuspenseQuery(customerQueryOptions(customerId));
  return (
    <CustomerForm
      key={customerId}
      isEdit
      defaultValues={{
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
      }}
    />
  );
}
