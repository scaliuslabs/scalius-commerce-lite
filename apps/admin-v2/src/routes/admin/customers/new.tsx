import { createFileRoute } from "@tanstack/react-router";
import { CustomerForm } from "~/components/admin/CustomerForm";

const defaultValues = {
  name: "",
  email: null,
  phone: "",
  address: null,
  city: null,
  zone: null,
  area: null,
};

export const Route = createFileRoute("/admin/customers/new")({
  head: () => ({ meta: [{ title: "New Customer | Scalius Admin" }] }),
  component: NewCustomerPage,
});

function NewCustomerPage() {
  return (
    <div className="container max-w-7xl py-4 pb-8">
      <CustomerForm defaultValues={defaultValues} isEdit={false} />
    </div>
  );
}
