import { useCallback } from "react";
import { createFileRoute, useNavigate, stripSearchParams } from "@tanstack/react-router";
import { AbandonedCheckoutList } from "~/components/admin/order-list/AbandonedCheckoutList";
import {
  validateAbandonedCheckoutSearch,
  type AbandonedCheckoutRouteState,
} from "~/lib/abandoned-checkout-route-state";
import { RouteErrorComponent } from "~/lib/route-error";
import { translate } from "~/i18n";
import { orderListMessages } from "~/i18n/order-list";

export const Route = createFileRoute("/admin/orders/_list/abandoned")({
  validateSearch: validateAbandonedCheckoutSearch,
  search: {
    middlewares: [stripSearchParams({ page: 1, limit: 20, search: "", sort: "updatedAt", order: "desc" })],
  },
  head: () => ({
    meta: [{ title: `${translate(orderListMessages, "abandonedTitle")} | Scalius Admin` }],
  }),
  errorComponent: RouteErrorComponent,
  component: AbandonedCheckoutsPage,
});

function AbandonedCheckoutsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const onChange = useCallback(
    (updates: Partial<AbandonedCheckoutRouteState>, options?: { replace?: boolean }) => {
      void navigate({
        search: (previous) => ({ ...previous, ...updates }),
        replace: options?.replace,
      });
    },
    [navigate],
  );
  return <AbandonedCheckoutList routeState={search} onRouteStateChange={onChange} />;
}
