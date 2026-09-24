import { createFileRoute } from "@tanstack/react-router";
import { PreferencesPage } from "~/components/admin/online-store/PreferencesPage";
import { seoSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/online-store/preferences")({
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(seoSettingsQueryOptions()),
  head: () => pageHead("preferences"),
  component: PreferencesPage,
  errorComponent: RouteErrorComponent,
});
