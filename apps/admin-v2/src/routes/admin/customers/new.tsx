import { createFileRoute } from "@tanstack/react-router";
import { CustomerForm } from "~/components/admin/CustomerForm";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/customers/new")({
  head: () => pageHead("newCustomer"),
  component: () => <CustomerForm />,
});
