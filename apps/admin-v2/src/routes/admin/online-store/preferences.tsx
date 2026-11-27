import { createFileRoute } from "@tanstack/react-router";
import { PreferencesPage } from "~/components/admin/online-store/PreferencesPage";
import { catalogSettingsQueryOptions, seoSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/online-store/preferences")({
  loader: ({ context: { queryClient } }) => Promise.all([
    queryClient.ensureQueryData(seoSettingsQueryOptions()),
    queryClient.ensureQueryData(catalogSettingsQueryOptions()),
  ]),
  head: () => pageHead("preferences"),
  component: PreferencesPage,
  errorComponent: RouteErrorComponent,
});
