import { createFileRoute } from "@tanstack/react-router";
import { HeroSliderManager } from "~/components/admin/hero-slider";
import { heroSlidersQueryOptions } from "~/lib/api-query-options/hero-sliders";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/hero-sliders")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(heroSlidersQueryOptions());
  },
  head: () => ({ meta: [{ title: "Hero Sliders | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: HeroSlidersPage,
});

function HeroSlidersPage() {
  return <HeroSliderManager />;
}
