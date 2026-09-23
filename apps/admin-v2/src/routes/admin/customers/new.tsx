import { createFileRoute } from "@tanstack/react-router";
import { CustomerForm } from "~/components/admin/CustomerForm";
import { translate } from "~/i18n";
import { customersMessages } from "~/i18n/customers";

export const Route = createFileRoute("/admin/customers/new")({
  head: () => ({ meta: [{ title: translate(customersMessages, "newCustomer") }] }),
  component: () => <CustomerForm />,
});
