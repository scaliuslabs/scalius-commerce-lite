import { createFileRoute } from "@tanstack/react-router";
import { UrlRedirectsPage } from "~/components/admin/online-store/UrlRedirectsPage";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/online-store/navigation/redirects")({
  head: () => pageHead("urlRedirects"),
  component: UrlRedirectsPage,
  errorComponent: RouteErrorComponent,
});
