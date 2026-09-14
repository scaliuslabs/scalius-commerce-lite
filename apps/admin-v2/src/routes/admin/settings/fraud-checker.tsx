import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { FraudCheckerSettings } from "~/components/admin/FraudCheckerSettings";
import { SettingsLayout } from "~/components/admin/settings/SettingsLayout";
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
    <SettingsLayout
      pathname="/admin/settings/fraud-checker"
      title="Fraud checks"
      description="Risk lookup providers a merchant can run while reviewing an order."
    >
      <FraudCheckerSettings providers={providers} />
    </SettingsLayout>
  );
}
