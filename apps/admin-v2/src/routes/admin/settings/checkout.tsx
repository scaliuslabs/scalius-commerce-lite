import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import CheckoutSettingsPage from "~/components/admin/settings/CheckoutSettingsPage";
import {
  normalizeCheckoutSettingsSection,
  type CheckoutSettingsSection,
} from "~/components/admin/settings/checkout-settings-sections";
import { checkoutFlowSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { RouteErrorComponent } from "~/lib/route-error";

export function validateCheckoutSettingsSearch(
  search: Record<string, unknown>,
) {
  return { section: normalizeCheckoutSettingsSection(search.section) };
}

export const Route = createFileRoute("/admin/settings/checkout")({
  validateSearch: validateCheckoutSettingsSearch,
  loader: async ({ context: { queryClient } }) => {
    await queryClient.prefetchQuery(checkoutFlowSettingsQueryOptions());
  },
  head: () => ({ meta: [{ title: "Checkout Settings | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: CheckoutPage,
});

function CheckoutPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const handleSectionChange = useCallback(
    (section: CheckoutSettingsSection) => {
      void navigate({
        resetScroll: false,
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          section,
        })) as never,
      });
    },
    [navigate],
  );

  return (
    <CheckoutSettingsPage
      section={search.section}
      onSectionChange={handleSectionChange}
    />
  );
}
