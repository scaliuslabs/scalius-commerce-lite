import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SaveBarProvider } from "~/components/admin/shared/SaveBar";

// Shopify's settings: the navigation panel swaps to the settings list (with
// Back) while these pages are open (AppSidebar); moving between them swaps
// only the Outlet, and one contextual save bar serves every page.
export const Route = createFileRoute("/admin/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <SaveBarProvider>
      <Outlet />
    </SaveBarProvider>
  );
}
