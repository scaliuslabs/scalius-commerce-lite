import { createFileRoute } from "@tanstack/react-router";
import { AbandonedCheckoutsManager } from "~/components/admin/AbandonedCheckoutsManager";
import { abandonedCheckoutsQueryOptions } from "~/lib/api.queries";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/abandoned-checkouts")({
  loader: async ({ context: { queryClient } }) => {
    if (typeof window === "undefined") return;
    await queryClient.ensureQueryData(
      abandonedCheckoutsQueryOptions({ page: 1, limit: 20, sort: "updatedAt", order: "desc" }),
    );
  },
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
