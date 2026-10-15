import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/objects/new")({
  codeSplitGroupings: [["loader", "component", "errorComponent"]],
  head: () => pageHead("newObject"),
  errorComponent: RouteErrorComponent,
  component: lazyRouteComponent(() => import("~/components/admin/objects/pages"), "NewTypePage"),
});
