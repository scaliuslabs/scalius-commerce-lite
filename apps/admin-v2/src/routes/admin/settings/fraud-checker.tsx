import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { FraudCheckerSettings } from "~/components/admin/FraudCheckerSettings";
import { fraudCheckerProvidersQueryOptions } from "~/lib/api-query-options/fraud-checker";
import type { FraudCheckerProviderPayload } from "~/lib/api-functions/fraud-checker";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/fraud-checker")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(fraudCheckerProvidersQueryOptions());
  },
  head: () => ({ meta: [{ title: "Fraud checks | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: FraudCheckerPage,
});

function FraudCheckerPage() {
  const { data } = useSuspenseQuery(fraudCheckerProvidersQueryOptions());
  const providers: FraudCheckerProviderPayload[] = Array.isArray(data) ? data : [];

  return (
    <div className="container max-w-6xl space-y-4 py-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Fraud checks</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Risk lookup providers for order review.
        </p>
      </div>
      <FraudCheckerSettings providers={providers} />
    </div>
  );
}
