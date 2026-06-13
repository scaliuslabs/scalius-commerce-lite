import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import GeneralSettingsPage from "~/components/admin/settings/GeneralSettingsPage";
import { generalSettingsQueryOptions } from "~/lib/api.queries";
import type { HeaderConfig } from "~/components/admin/header-builder/types";
import type { FooterConfig } from "~/components/admin/footer-builder/types";

export const Route = createFileRoute("/admin/settings/")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(generalSettingsQueryOptions());
  },
  head: () => ({ meta: [{ title: "General Settings | Scalius Admin" }] }),
  component: SettingsPage,
  errorComponent: ({ error, reset }) => (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <p className="text-4xl font-bold text-muted-foreground mb-2">Error</p>
      <p className="text-sm text-muted-foreground mb-4">
        {error instanceof Error ? error.message : "Something went wrong loading this page."}
      </p>
      <button
        onClick={reset}
        className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        Try Again
      </button>
    </div>
  ),
});

function SettingsPage() {
  const { data } = useSuspenseQuery(generalSettingsQueryOptions());
  const result = data as unknown as {
    headerConfig?: HeaderConfig | null;
    footerConfig?: FooterConfig | null;
  };

  return (
    <GeneralSettingsPage
      headerConfig={result.headerConfig ?? null}
      footerConfig={result.footerConfig ?? null}
    />
  );
}
