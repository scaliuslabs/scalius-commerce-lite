import { createFileRoute } from "@tanstack/react-router";
import { NavigationPage } from "~/components/admin/online-store/NavigationPage";
import {
  footerQueryOptions,
  headerQueryOptions,
  navigationMenusQueryOptions,
  navigationPlacementsQueryOptions,
} from "~/lib/api-query-options/online-store";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/online-store/navigation/")({
  loader: ({ context: { queryClient } }) => Promise.all([
    queryClient.ensureQueryData(navigationMenusQueryOptions()),
    queryClient.ensureQueryData(navigationPlacementsQueryOptions()),
    queryClient.ensureQueryData(headerQueryOptions()),
    queryClient.ensureQueryData(footerQueryOptions()),
  ]),
  head: () => pageHead("navigation"),
  component: NavigationPage,
  errorComponent: RouteErrorComponent,
});
