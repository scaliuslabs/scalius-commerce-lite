import { createFileRoute, redirect } from "@tanstack/react-router";
import { CustomerForm } from "~/components/admin/CustomerForm";
import { getCustomer } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/customers/$customerId/edit")({
  loader: async ({ params }) => {
    const customer = await getCustomer({ data: { id: params.customerId } }).catch(() => null);
    if (!customer) throw redirect({ to: "/admin/customers" });
    const c = customer as any;
    return {
      customer: {
        ...c,
        cityName: c.cityName || "",
        zoneName: c.zoneName || "",
        areaName: c.areaName || "",
      },
    };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `Edit ${loaderData?.customer?.name || "Customer"} | Scalius Admin` }],
  }),
  component: EditCustomerPage,
});

function EditCustomerPage() {
  const { customer } = Route.useLoaderData();

  if (!customer) {
    return <div>Customer not found</div>;
  }

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <CustomerForm defaultValues={customer} isEdit={true} />
    </div>
  );
}
