import { createFileRoute } from "@tanstack/react-router";
import { MenuPage } from "~/components/admin/online-store/MenuPage";
import {
  navigationMenuQueryOptions,
  navigationPlacementsQueryOptions,
} from "~/lib/api-query-options/online-store";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/online-store/navigation/$menuId")({
  loader: ({ context: { queryClient }, params }) => Promise.all([
    queryClient.ensureQueryData(navigationMenuQueryOptions(params.menuId)),
    queryClient.ensureQueryData(navigationPlacementsQueryOptions()),
  ]),
  head: () => pageHead("navigation"),
  component: MenuRoute,
  errorComponent: RouteErrorComponent,
});

function MenuRoute() {
  const { menuId } = Route.useParams();
  return <MenuPage key={menuId} menuId={menuId} />;
}
