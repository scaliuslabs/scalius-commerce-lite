import { createFileRoute } from "@tanstack/react-router";
import { AbandonedCheckoutsManager } from "~/components/admin/AbandonedCheckoutsManager";
import { abandonedCheckoutsQueryOptions } from "~/lib/api.queries";

export const Route = createFileRoute("/admin/abandoned-checkouts")({
  loader: async ({ context: { queryClient } }) => {
    // Prefetch with the exact same default params the component uses on mount
    // (search starts as "" which becomes undefined via `|| undefined`)
    await queryClient.ensureQueryData(
      abandonedCheckoutsQueryOptions({
        page: 1,
        limit: 20,
        search: undefined,
        sort: "updatedAt",
        order: "desc",
      }),
    );
  },
  head: () => ({ meta: [{ title: "Incomplete Orders | Scalius Admin" }] }),
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
