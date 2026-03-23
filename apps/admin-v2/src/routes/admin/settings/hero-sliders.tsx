import { createFileRoute } from "@tanstack/react-router";
import { HeroSliderManager } from "~/components/admin/hero-slider";

export const Route = createFileRoute("/admin/settings/hero-sliders")({
  head: () => ({ meta: [{ title: "Hero Sliders | Scalius Admin" }] }),
  component: HeroSlidersPage,
});

function HeroSlidersPage() {
  return <HeroSliderManager />;
}
