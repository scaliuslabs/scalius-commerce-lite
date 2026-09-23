import { createFileRoute } from "@tanstack/react-router";
import { ThemePage } from "~/components/admin/online-store/ThemePage";
import {
  footerQueryOptions,
  headerQueryOptions,
  themeQueryOptions,
} from "~/lib/api-query-options/online-store";
import { RouteErrorComponent } from "~/lib/route-error";
import { translate } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";

export const Route = createFileRoute("/admin/online-store/theme")({
  loader: ({ context: { queryClient } }) => Promise.all([
    queryClient.ensureQueryData(themeQueryOptions()),
    queryClient.ensureQueryData(headerQueryOptions()),
    queryClient.ensureQueryData(footerQueryOptions()),
  ]),
  head: () => ({ meta: [{ title: `${translate(onlineStoreMessages, "themeTitle")} | Scalius` }] }),
  component: ThemePage,
  errorComponent: RouteErrorComponent,
});
