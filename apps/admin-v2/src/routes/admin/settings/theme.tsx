import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import ThemeSettingsPage from "~/components/admin/settings/ThemeSettingsPage";
import {
  normalizeThemeWorkspaceSection,
  type ThemeWorkspaceSection,
} from "~/components/admin/settings/theme-workspace";
import { RouteErrorComponent } from "~/lib/route-error";

export function validateThemeSearch(search: Record<string, unknown>) {
  return { section: normalizeThemeWorkspaceSection(search.section) };
}

export const Route = createFileRoute("/admin/settings/theme")({
  validateSearch: validateThemeSearch,
  head: () => ({ meta: [{ title: "Theme | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: ThemePage,
});

function ThemePage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const handleSectionChange = useCallback(
    (section: ThemeWorkspaceSection) => {
      void navigate({
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          section,
        })) as never,
      });
    },
    [navigate],
  );

  return (
    <ThemeSettingsPage
      section={search.section}
      onSectionChange={handleSectionChange}
    />
  );
}
