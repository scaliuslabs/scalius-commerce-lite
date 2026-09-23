import { createFileRoute } from "@tanstack/react-router";
import { PreferencesPage } from "~/components/admin/online-store/PreferencesPage";
import { seoSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { RouteErrorComponent } from "~/lib/route-error";
import { translate } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";

export const Route = createFileRoute("/admin/online-store/preferences")({
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(seoSettingsQueryOptions()),
  head: () => ({ meta: [{ title: `${translate(onlineStoreMessages, "preferencesTitle")} | Scalius` }] }),
  component: PreferencesPage,
  errorComponent: RouteErrorComponent,
});
