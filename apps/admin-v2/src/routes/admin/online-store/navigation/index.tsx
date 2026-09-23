import { createFileRoute } from "@tanstack/react-router";
import { NavigationPage } from "~/components/admin/online-store/NavigationPage";
import {
  footerQueryOptions,
  headerQueryOptions,
  navigationMenusQueryOptions,
  navigationPlacementsQueryOptions,
} from "~/lib/api-query-options/online-store";
import { RouteErrorComponent } from "~/lib/route-error";
import { translate } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";

export const Route = createFileRoute("/admin/online-store/navigation/")({
  loader: ({ context: { queryClient } }) => Promise.all([
    queryClient.ensureQueryData(navigationMenusQueryOptions()),
    queryClient.ensureQueryData(navigationPlacementsQueryOptions()),
    queryClient.ensureQueryData(headerQueryOptions()),
    queryClient.ensureQueryData(footerQueryOptions()),
  ]),
  head: () => ({ meta: [{ title: `${translate(onlineStoreMessages, "navigationTitle")} | Scalius` }] }),
  component: NavigationPage,
  errorComponent: RouteErrorComponent,
});
