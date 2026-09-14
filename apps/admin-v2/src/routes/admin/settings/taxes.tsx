import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Suspense, useCallback } from "react";

import { TaxSettingsPage, TaxSettingsPageSkeleton } from "~/components/admin/taxes";
import {
  normalizeTaxClassificationRouteState,
  type TaxClassificationRouteState,
} from "~/components/admin/taxes/tax-classification-route-state";
import {
  normalizeTaxWorkspacePreview,
  normalizeTaxWorkspaceSection,
  type TaxWorkspaceSection,
} from "~/components/admin/taxes/tax-workspace-sections";
import { taxConfigurationQueryOptions } from "~/lib/api-query-options/taxes";
import {
  ADMIN_ACCESS_DENIED_PATH,
  canAccessAdminPath,
} from "~/lib/admin-access";
import { getFreshAdminRouteContext } from "~/lib/admin-route-context";
import { RouteErrorComponent } from "~/lib/route-error";
import { useWorkspaceScrollMemory } from "~/hooks/use-workspace-scroll-memory";

export async function requireFreshTaxesRouteAuthority() {
  const context = await getFreshAdminRouteContext();
  if (!canAccessAdminPath("/admin/settings/taxes", context)) {
    throw redirect({ to: ADMIN_ACCESS_DENIED_PATH, replace: true });
  }
  return context;
}

/**
 * Route search shape. Declared as a type alias (not an interface) so it keeps
 * an implicit index signature and can still be read as a plain record by the
 * classification normalizer.
 */
export type TaxesRouteSearch = {
  section: TaxWorkspaceSection;
  /** The calculation preview sheet is open. */
  preview?: true;
  kind?: "variant";
  query?: string;
  page?: number;
};

export function validateTaxesSearch(
  search: Record<string, unknown>,
): TaxesRouteSearch {
  const classification = normalizeTaxClassificationRouteState(search);
  return {
    // Retired `?section=` values (policy, preview) resolve onto the redesigned
    // tabs so saved links keep landing on the same capability.
    section: normalizeTaxWorkspaceSection(search.section),
    ...(normalizeTaxWorkspacePreview(search) ? { preview: true } : {}),
    ...(classification.kind === "variant" ? { kind: classification.kind } : {}),
    ...(classification.search ? { query: classification.search } : {}),
    ...(classification.page > 1 ? { page: classification.page } : {}),
  };
}

export const Route = createFileRoute("/admin/settings/taxes")({
  validateSearch: validateTaxesSearch,
  beforeLoad: requireFreshTaxesRouteAuthority,
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(taxConfigurationQueryOptions());
  },
  head: () => ({ meta: [{ title: "Taxes | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: TaxesPage,
});

function TaxesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const classificationRouteState = normalizeTaxClassificationRouteState(search);
  const previewOpen = Boolean(search.preview);
  const rememberWorkspaceScroll = useWorkspaceScrollMemory(
    `${search.section}:${classificationRouteState.kind}:${classificationRouteState.search}:${classificationRouteState.page}`,
  );
  const handleSectionChange = useCallback(
    (section: TaxWorkspaceSection) => {
      void navigate({
        resetScroll: false,
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          section,
          preview: undefined,
        })) as never,
      });
    },
    [navigate],
  );
  const handlePreviewOpenChange = useCallback(
    (open: boolean) => {
      void navigate({
        resetScroll: false,
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          preview: open ? true : undefined,
        })) as never,
      });
    },
    [navigate],
  );
  const handleClassificationRouteStateChange = useCallback(
    (state: TaxClassificationRouteState) => {
      void navigate({
        resetScroll: false,
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          section: "classification",
          kind: state.kind === "product" ? undefined : state.kind,
          query: state.search || undefined,
          page: state.page === 1 ? undefined : state.page,
        })) as never,
      });
    },
    [navigate],
  );

  return (
    <div
      className="contents"
      onPointerDownCapture={rememberWorkspaceScroll}
      onKeyDownCapture={rememberWorkspaceScroll}
    >
      <Suspense fallback={<TaxSettingsPageSkeleton />}>
        <TaxSettingsPage
          section={search.section}
          onSectionChange={handleSectionChange}
          previewOpen={previewOpen}
          onPreviewOpenChange={handlePreviewOpenChange}
          classificationRouteState={classificationRouteState}
          onClassificationRouteStateChange={handleClassificationRouteStateChange}
        />
      </Suspense>
    </div>
  );
}
