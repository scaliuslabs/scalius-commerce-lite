import { createFileRoute } from "@tanstack/react-router";
import ThemeSettingsPage from "~/components/admin/settings/ThemeSettingsPage";
import { themeSettingsQueryOptions } from "~/lib/api.queries";

export const Route = createFileRoute("/admin/settings/theme")({
  loader: async ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(themeSettingsQueryOptions());
  },
  head: () => ({ meta: [{ title: "Theme | Scalius Admin" }] }),
  component: ThemePage,
});

function ThemePage() {
  return <ThemeSettingsPage />;
}
