import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { HeroSliderManager } from "~/components/admin/hero-slider";
import {
  normalizeHeroSliderWorkspaceSection,
  type HeroSliderWorkspaceSection,
} from "~/components/admin/hero-slider/hero-slider-workspace";
import { RouteErrorComponent } from "~/lib/route-error";
import { useWorkspaceScrollMemory } from "~/hooks/use-workspace-scroll-memory";

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
  const rememberWorkspaceScroll = useWorkspaceScrollMemory(search.section);
  const handleSectionChange = useCallback(
    (section: HeroSliderWorkspaceSection) => {
      void navigate({
        resetScroll: false,
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          section,
        })) as never,
      });
    },
    [navigate],
  );

  return (
    <div
      className="contents"
      onPointerDownCapture={rememberWorkspaceScroll}
      onKeyDownCapture={rememberWorkspaceScroll}
    >
      <HeroSliderManager
        section={search.section}
        onSectionChange={handleSectionChange}
      />
    </div>
  );
}
