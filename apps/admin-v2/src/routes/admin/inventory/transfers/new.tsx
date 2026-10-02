import { createFileRoute } from "@tanstack/react-router";
import { TransferEditor } from "~/components/admin/purchasing/TransferEditor";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/inventory/transfers/new")({
  head: () => pageHead("createTransfer"),
  errorComponent: RouteErrorComponent,
  component: () => <TransferEditor transfer={null} />,
});
