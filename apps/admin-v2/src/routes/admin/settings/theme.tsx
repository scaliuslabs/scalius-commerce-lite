import { createFileRoute } from "@tanstack/react-router";
import ThemeSettingsPage from "~/components/admin/settings/ThemeSettingsPage";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/theme")({
  head: () => ({ meta: [{ title: "Theme | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: ThemePage,
});

function ThemePage() {
  return <ThemeSettingsPage />;
}
