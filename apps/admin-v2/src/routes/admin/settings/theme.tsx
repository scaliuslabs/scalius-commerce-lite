import { createFileRoute } from "@tanstack/react-router";
import ThemeSettingsPage from "~/components/admin/settings/ThemeSettingsPage";
import { themeSettingsQueryOptions } from "~/lib/api.queries";
import { RouteErrorComponent } from "~/lib/list-helpers";

export const Route = createFileRoute("/admin/settings/theme")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(themeSettingsQueryOptions());
  },
  head: () => ({ meta: [{ title: "Theme | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: ThemePage,
});

function ThemePage() {
  return <ThemeSettingsPage />;
}
