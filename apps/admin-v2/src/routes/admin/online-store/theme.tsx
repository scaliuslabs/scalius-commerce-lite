import { createFileRoute } from "@tanstack/react-router";
import { ThemePage } from "~/components/admin/online-store/ThemePage";
import {
  footerQueryOptions,
  headerQueryOptions,
  themeQueryOptions,
} from "~/lib/api-query-options/online-store";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/online-store/theme")({
  loader: ({ context: { queryClient } }) => Promise.all([
    queryClient.ensureQueryData(themeQueryOptions()),
    queryClient.ensureQueryData(headerQueryOptions()),
    queryClient.ensureQueryData(footerQueryOptions()),
  ]),
  head: () => pageHead("theme"),
  component: ThemePage,
  errorComponent: RouteErrorComponent,
});
