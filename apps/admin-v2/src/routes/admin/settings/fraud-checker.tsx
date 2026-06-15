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
  head: () => ({ meta: [{ title: "Fraud Checker | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: FraudCheckerPage,
});

function FraudCheckerPage() {
  const { data } = useSuspenseQuery(fraudCheckerProvidersQueryOptions());
  const providers: FraudCheckerProviderPayload[] = Array.isArray(data) ? data : [];

  return (
    <div className="container py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Fraud Checker</h1>
          <p className="text-muted-foreground">
            Configure fraud detection providers for customer verification
          </p>
        </div>
      </div>
      <FraudCheckerSettings providers={providers} />
    </div>
  );
}
