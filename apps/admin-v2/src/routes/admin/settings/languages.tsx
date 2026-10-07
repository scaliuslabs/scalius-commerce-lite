import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { AppProviderSheetHost } from "~/components/admin/apps/AppProviderSheetHost";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { LanguagesSettings } from "~/components/admin/settings/languages/LanguagesSettings";
import { storeLanguagesQueryOptions } from "~/lib/api-query-options/translations";
import { RouteErrorComponent } from "~/lib/route-error";

// Settings › Languages (docs/MARKETS-DESIGN.md D9): the store's languages.
export const Route = createFileRoute("/admin/settings/languages")({
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(storeLanguagesQueryOptions()).catch(() => undefined),
  head: () => settingsHead("languages"),
  errorComponent: RouteErrorComponent,
  component: LanguagesPage,
});

function LanguagesPage() {
  // An app's machine translation provider opens its setup sheet here.
  return (
    <AppProviderSheetHost>
      <SettingsPage page="languages">
        <LanguagesSettings />
      </SettingsPage>
    </AppProviderSheetHost>
  );
}
