import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { WarrantyPoliciesManager } from "~/components/admin/settings/warranty-policies/WarrantyPoliciesManager";
import { warrantyPoliciesQueryOptions } from "~/components/admin/warranty/warranty-api";
import { RouteErrorComponent } from "~/lib/route-error";
import { useMessages } from "~/i18n";
import { settingsNavMessages } from "~/i18n/settings";
import { warrantyMessages } from "~/i18n/warranty";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/settings/policies_/warranty")({
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(warrantyPoliciesQueryOptions(false)).catch(() => undefined),
  head: () => pageHead("warrantyPolicies"),
  errorComponent: RouteErrorComponent,
  component: WarrantyPoliciesPage,
});

function WarrantyPoliciesPage() {
  const t = useMessages(warrantyMessages);
  const nav = useMessages(settingsNavMessages);
  return (
    <SettingsPage page="policies" title={t("title")} back={{ to: "/admin/settings/policies", label: nav("policies") }}>
      <WarrantyPoliciesManager />
    </SettingsPage>
  );
}
