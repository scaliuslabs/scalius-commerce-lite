import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AbandonedCheckoutsManager } from "~/components/admin/AbandonedCheckoutsManager";
import { validateAbandonedCheckoutSearch } from "~/lib/abandoned-checkout-route-state";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/abandoned-checkouts")({
  validateSearch: validateAbandonedCheckoutSearch,
  head: () => ({ meta: [{ title: "Incomplete Checkouts | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: AbandonedCheckoutsPage,
});

function AbandonedCheckoutsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Incomplete Checkouts</h1>
        <p className="text-sm text-muted-foreground">
          Review active checkout sessions and archived hosted payments. Completed
          checkouts clear automatically.
        </p>
      </div>
      <AbandonedCheckoutsManager
        routeState={search}
        onRouteStateChange={(updates, options) => {
          void navigate({
            search: (previous) => ({ ...previous, ...updates }),
            replace: options?.replace,
          });
        }}
      />
    </div>
  );
}
