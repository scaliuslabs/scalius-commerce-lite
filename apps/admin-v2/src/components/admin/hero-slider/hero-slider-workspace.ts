export const HERO_SLIDER_WORKSPACE_SECTIONS = ["desktop", "mobile"] as const;

export type HeroSliderWorkspaceSection =
  (typeof HERO_SLIDER_WORKSPACE_SECTIONS)[number];

export function normalizeHeroSliderWorkspaceSection(
  value: unknown,
): HeroSliderWorkspaceSection {
  return typeof value === "string" &&
    HERO_SLIDER_WORKSPACE_SECTIONS.includes(
      value as HeroSliderWorkspaceSection,
    )
    ? (value as HeroSliderWorkspaceSection)
    : "desktop";
}
