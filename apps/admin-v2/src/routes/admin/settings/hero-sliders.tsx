import { createFileRoute } from "@tanstack/react-router";
import { HeroSliderManager } from "~/components/admin/hero-slider";
import { heroSlidersQueryOptions } from "~/lib/api.queries";

export const Route = createFileRoute("/admin/settings/hero-sliders")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(heroSlidersQueryOptions());
  },
  head: () => ({ meta: [{ title: "Hero Sliders | Scalius Admin" }] }),
  component: HeroSlidersPage,
});

function HeroSlidersPage() {
  return <HeroSliderManager />;
}
