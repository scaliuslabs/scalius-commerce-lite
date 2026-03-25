import { createFileRoute } from "@tanstack/react-router";
import { HeroSliderManager } from "~/components/admin/hero-slider";
import { heroSlidersQueryOptions } from "~/lib/api.queries";
import { RouteErrorComponent } from "~/lib/list-helpers";

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
