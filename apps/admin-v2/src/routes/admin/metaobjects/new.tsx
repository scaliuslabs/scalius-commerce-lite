import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/metaobjects/new")({
  codeSplitGroupings: [["loader", "component", "errorComponent"]],
  head: () => pageHead("newMetaobject"),
  errorComponent: RouteErrorComponent,
  component: lazyRouteComponent(() => import("~/components/admin/metaobjects/pages"), "NewTypePage"),
});
