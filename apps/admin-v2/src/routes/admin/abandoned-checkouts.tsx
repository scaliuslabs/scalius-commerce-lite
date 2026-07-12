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
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Incomplete Orders</h1>
        <p className="text-sm text-muted-foreground">
          Review active checkout sessions and archived hosted-payment recovery records.
          Completed orders are cleared automatically.
        </p>
      </div>
      <AbandonedCheckoutsManager />
    </div>
  );
}
