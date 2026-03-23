import { createFileRoute } from "@tanstack/react-router";
import { FraudCheckerSettings } from "~/components/admin/FraudCheckerSettings";
import { getFraudCheckerProviders } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/settings/fraud-checker")({
  loader: async () => {
    const result = await getFraudCheckerProviders().catch(() => []);
    const providers = (Array.isArray(result) ? result : []) as any[];
    return { providers };
  },
  head: () => ({ meta: [{ title: "Fraud Checker | Scalius Admin" }] }),
  component: FraudCheckerPage,
});

function FraudCheckerPage() {
  const { providers } = Route.useLoaderData();

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
