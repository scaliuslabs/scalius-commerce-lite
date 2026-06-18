import { createFileRoute } from "@tanstack/react-router";
import { AbandonedCheckoutsManager } from "~/components/admin/AbandonedCheckoutsManager";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/abandoned-checkouts")({
  head: () => ({ meta: [{ title: "Incomplete Orders | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: AbandonedCheckoutsPage,
});

function AbandonedCheckoutsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Incomplete Orders</h1>
        <p className="text-muted-foreground">
          View and manage incomplete orders. Records are automatically cleared when an order is completed.
        </p>
      </div>
      <AbandonedCheckoutsManager />
    </div>
  );
}
