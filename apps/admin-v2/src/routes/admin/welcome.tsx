import { createFileRoute, redirect } from "@tanstack/react-router";
import { Card } from "~/components/ui/card";
import { StoreSetupForm } from "~/components/admin/onboarding/StoreSetupForm";
import { storeSetupQueryOptions } from "~/lib/api-query-options/store-defaults";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

/**
 * The new-store setup step, full window like Shopify's. A store that is
 * already set up (an order, or edited markets) goes straight to Home.
 */
export const Route = createFileRoute("/admin/welcome")({
  loader: async ({ context: { queryClient } }) => {
    const status = await queryClient.fetchQuery(storeSetupQueryOptions());
    if (!status.needed) throw redirect({ to: "/admin" });
    return { status };
  },
  head: () => pageHead("storeSetup"),
  errorComponent: RouteErrorComponent,
  component: StoreSetupPage,
});

function StoreSetupPage() {
  const { status } = Route.useLoaderData();
  return (
    <main className="flex h-full flex-col items-center overflow-y-auto bg-background px-4 py-10">
      <Card className="w-full max-w-lg p-6 sm:mt-[8vh] sm:p-8">
        <StoreSetupForm status={status} />
      </Card>
    </main>
  );
}
