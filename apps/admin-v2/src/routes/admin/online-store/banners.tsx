import { createFileRoute } from "@tanstack/react-router";
import { BannersPage } from "~/components/admin/online-store/BannersPage";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import {
  heroSlidersQueryOptions,
  homepageSectionsQueryOptions,
} from "~/lib/api-query-options/online-store";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/online-store/banners")({
  loader: ({ context: { queryClient } }) => Promise.all([
    queryClient.ensureQueryData(heroSlidersQueryOptions()),
    queryClient.ensureQueryData(homepageSectionsQueryOptions()),
    queryClient.ensureQueryData(categoryFormOptionsQueryOptions()),
  ]),
  head: () => pageHead("homepageBanners"),
  component: BannersPage,
  errorComponent: RouteErrorComponent,
});
