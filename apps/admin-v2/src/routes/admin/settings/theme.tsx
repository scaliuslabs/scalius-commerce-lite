import { createFileRoute } from "@tanstack/react-router";
import ThemeSettingsPage from "~/components/admin/settings/ThemeSettingsPage";

export const Route = createFileRoute("/admin/settings/theme")({
  head: () => ({ meta: [{ title: "Theme | Scalius Admin" }] }),
  component: ThemePage,
});

function ThemePage() {
  return <ThemeSettingsPage />;
}
