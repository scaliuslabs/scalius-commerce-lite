import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { HeroSliderManager } from "~/components/admin/hero-slider";
import {
  normalizeHeroSliderWorkspaceSection,
  type HeroSliderWorkspaceSection,
} from "~/components/admin/hero-slider/hero-slider-workspace";
import { RouteErrorComponent } from "~/lib/route-error";

export function validateHeroSliderSearch(search: Record<string, unknown>) {
  return { section: normalizeHeroSliderWorkspaceSection(search.section) };
}

export const Route = createFileRoute("/admin/settings/hero-sliders")({
  validateSearch: validateHeroSliderSearch,
  head: () => ({ meta: [{ title: "Hero Sliders | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: HeroSlidersPage,
});

function HeroSlidersPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const handleSectionChange = useCallback(
    (section: HeroSliderWorkspaceSection) => {
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
    <HeroSliderManager
      section={search.section}
      onSectionChange={handleSectionChange}
    />
  );
}
