import { createFileRoute } from "@tanstack/react-router";
import { HeroSliderManager } from "~/components/admin/hero-slider";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/hero-sliders")({
  head: () => ({ meta: [{ title: "Hero Sliders | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: HeroSlidersPage,
});

function HeroSlidersPage() {
  return <HeroSliderManager />;
}
