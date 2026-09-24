import { useCallback } from "react";
import { createFileRoute, retainSearchParams, stripSearchParams, useNavigate } from "@tanstack/react-router";
import {
  AbandonedCheckoutList,
  type AbandonedCheckoutListState,
} from "~/components/admin/order-list/AbandonedCheckoutList";
import { validateAbandonedCheckoutSearch } from "~/lib/abandoned-checkout-route-state";
import type { SearchValidatorInput } from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

/** Page, sort and order live in the URL; the search term stays in this tab's session. */
function validateSearch(search: SearchValidatorInput<AbandonedCheckoutListState>): AbandonedCheckoutListState {
  const { search: _term, ...state } = validateAbandonedCheckoutSearch(search);
  return state;
}

export const Route = createFileRoute("/admin/orders/_list/abandoned")({
  validateSearch,
  search: {
    // Opening a checkout (…/abandoned/$checkoutId) keeps the list's page and sort behind the sheet.
    middlewares: [
      retainSearchParams(true),
      stripSearchParams({ page: 1, limit: 20, sort: "updatedAt", order: "desc" }),
    ],
  },
  head: () => pageHead("abandonedCheckouts"),
  errorComponent: RouteErrorComponent,
  component: AbandonedCheckoutsPage,
});

function AbandonedCheckoutsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/admin/orders/abandoned" });
  const onChange = useCallback(
    (updates: Partial<AbandonedCheckoutListState>, options?: { replace?: boolean }) => {
      void navigate({
        to: "/admin/orders/abandoned",
        search: (previous) => ({ ...previous, ...updates }),
        replace: options?.replace,
      });
    },
    [navigate],
  );
  return <AbandonedCheckoutList routeState={search} onRouteStateChange={onChange} />;
}
