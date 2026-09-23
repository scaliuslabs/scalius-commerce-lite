import { createFileRoute } from "@tanstack/react-router";
import { BannersPage } from "~/components/admin/online-store/BannersPage";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import {
  heroSlidersQueryOptions,
  homepageSectionsQueryOptions,
} from "~/lib/api-query-options/online-store";
import { RouteErrorComponent } from "~/lib/route-error";
import { translate } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";

export const Route = createFileRoute("/admin/online-store/banners")({
  loader: ({ context: { queryClient } }) => Promise.all([
    queryClient.ensureQueryData(heroSlidersQueryOptions()),
    queryClient.ensureQueryData(homepageSectionsQueryOptions()),
    queryClient.ensureQueryData(categoryFormOptionsQueryOptions()),
  ]),
  head: () => ({ meta: [{ title: `${translate(onlineStoreMessages, "bannersTitle")} | Scalius` }] }),
  component: BannersPage,
  errorComponent: RouteErrorComponent,
});
