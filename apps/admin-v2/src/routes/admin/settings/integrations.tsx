import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AiAccessCard } from "~/components/admin/agent-access/AiAccessCard";
import { AiDraftingCard } from "~/components/admin/agent-access/AiDraftingCard";
import { AppKindCard } from "~/components/admin/settings/AppKindCard";
import { FraudCheckCard, ScannerCard, TrackingCard } from "~/components/admin/settings/AppsSettings";
import { SettingsCardLoading, SettingsPage, SettingsSubPages } from "~/components/admin/settings/SettingsPage";
import { trackingHealthQuery, trackingSettingsQuery } from "~/components/admin/settings/tracking-settings";
import { useTrackingStatus } from "~/components/admin/settings/tracking-status";
import { settingsHead, settingsPartSearch } from "~/components/admin/settings/settings-nav";
import { settingsPartOf } from "~/components/admin/settings/settings-cards";
import { usePermissions } from "~/contexts/PermissionContext";
import { translate, useMessages } from "~/i18n";
import { titleHead } from "~/i18n/page-titles";
import { settingsPrivacyMessages } from "~/i18n/settings-privacy";
import { settingsSubPageMessages, settingsSubPageSummaryMessages } from "~/i18n/settings-sub-pages";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { fraudCheckerProvidersQueryOptions } from "~/lib/api-query-options/fraud-checker";
import { aiAccessQuery, appProvidersQuery, metaQuery, trackingQuery } from "~/lib/api-query-options/settings-screens";
import { RouteErrorComponent } from "~/lib/route-error";
import { viewerHolds } from "~/lib/route-query-warming";

/** Who may read the store's app providers (`GET /api/v1/admin/settings/providers`). */
const PROVIDER_READERS = [
  ADMIN_PERMISSIONS.SETTINGS_GENERAL_VIEW,
  ADMIN_PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW,
  ADMIN_PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW,
  ADMIN_PERMISSIONS.TAXES_VIEW,
];

// Integrations: three parts that serve different jobs (tracking and ads,
// order tools, AI and apps), each its own page at `?part=`
// (audit/settings-ux/NAVIGATION-DECISION.md). Without a part, the page lists
// them with their state. One route for all four, so the always-loaded route
// tree and its preload map stay as they were.
export const Route = createFileRoute("/admin/settings/integrations")({
  validateSearch: settingsPartSearch,
  loaderDeps: ({ search }) => ({ part: search.part }),
  // Cards hide themselves for roles that can't view them, and the loader reads only what this role may.
  loader: async ({ context: { queryClient, ...viewer }, deps }) => {
    const part = settingsPartOf("integrations", deps.part)?.key;
    const analytics = viewerHolds(viewer, ADMIN_PERMISSIONS.ANALYTICS_VIEW);
    const providers = viewerHolds(viewer, ...PROVIDER_READERS);
    const reads = {
      tracking: () => (analytics ? [queryClient.ensureQueryData(trackingHealthQuery)] : []),
      orderTools: () => (providers ? [queryClient.ensureQueryData(appProvidersQuery("courier_history"))] : []),
      aiApps: () => (providers ? [queryClient.ensureQueryData(appProvidersQuery("ai"))] : []),
    };
    await Promise.allSettled([
      // What the list summarises, and what the parts read first.
      ...(analytics
        ? [queryClient.ensureQueryData(trackingQuery), queryClient.ensureQueryData(metaQuery), queryClient.ensureQueryData(trackingSettingsQuery)]
        : []),
      ...(viewerHolds(viewer, ADMIN_PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW) ? [queryClient.ensureQueryData(fraudCheckerProvidersQueryOptions())] : []),
      ...(viewerHolds(viewer, ADMIN_PERMISSIONS.AGENT_ACCESS_VIEW) ? [queryClient.ensureQueryData(aiAccessQuery)] : []),
      ...(providers ? [queryClient.ensureQueryData(appProvidersQuery("search"))] : []),
      ...(part ? reads[part as keyof typeof reads]() : []),
    ]);
    return { title: part ? translate(settingsSubPageMessages, part) : null };
  },
  head: ({ loaderData }) => (loaderData?.title ? titleHead(loaderData.title) : settingsHead("integrations")),
  errorComponent: RouteErrorComponent,
  component: IntegrationsPage,
});

// The destination cards load after the page's own code.
const TrackingDestinationCards = lazy(() => import("~/components/admin/settings/TrackingDestinations"));

function IntegrationsPage() {
  const { part } = Route.useSearch();
  const { hasPermission } = usePermissions();
  const can = (...permissions: string[]) => permissions.some(hasPermission);
  const key = settingsPartOf("integrations", part)?.key;
  if (key === "tracking") {
    return (
      <SettingsPage page="integrations" subPage="tracking" readOnly={!can(ADMIN_PERMISSIONS.ANALYTICS_CREATE, ADMIN_PERMISSIONS.ANALYTICS_EDIT, ADMIN_PERMISSIONS.ANALYTICS_TOGGLE)}>
        <Suspense fallback={<SettingsCardLoading />}>
          <TrackingDestinationCards />
        </Suspense>
        <TrackingCard />
      </SettingsPage>
    );
  }
  if (key === "orderTools") {
    return (
      <SettingsPage page="integrations" subPage="orderTools" readOnly={!can(ADMIN_PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT, ADMIN_PERMISSIONS.PRODUCTS_EDIT)}>
        <FraudCheckCard />
        <ScannerCard />
      </SettingsPage>
    );
  }
  if (key === "aiApps") {
    return (
      <SettingsPage page="integrations" subPage="aiApps" readOnly={!can(ADMIN_PERMISSIONS.AGENT_ACCESS_MANAGE, ADMIN_PERMISSIONS.PRODUCTS_EDIT)}>
        <AiAccessCard />
        <AiDraftingCard />
        <AppKindCard kind="search" />
      </SettingsPage>
    );
  }
  return <IntegrationsList />;
}

const DESTINATIONS = ["ga4", "meta", "tiktok"] as const;

/** The three parts, each with its state in one line. */
function IntegrationsList() {
  const t = useMessages(settingsSubPageSummaryMessages);
  const privacy = useMessages(settingsPrivacyMessages);
  const { hasPermission } = usePermissions();
  const { destinations } = useTrackingStatus();
  const fraud = useQuery({ ...fraudCheckerProvidersQueryOptions(), enabled: hasPermission(ADMIN_PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW) });
  const ai = useQuery({ ...aiAccessQuery, enabled: hasPermission(ADMIN_PERMISSIONS.AGENT_ACCESS_VIEW) });
  const search = useQuery({ ...appProvidersQuery("search"), enabled: PROVIDER_READERS.some(hasPermission) });
  const tracking = hasPermission(ADMIN_PERMISSIONS.ANALYTICS_VIEW) && DESTINATIONS.every((destination) => destinations[destination].status)
    ? DESTINATIONS.map((destination) =>
        t("destination", { name: privacy(`short.${destination}`), status: privacy(`overall.${destinations[destination].status!}`) }),
      ).join(" · ")
    : null;
  const fraudLine = fraud.data ? t(fraud.data.some((provider) => provider.isActive) ? "fraudOn" : "fraudOff") : null;
  const searchApp = search.data?.find((provider) => provider.readiness.usable);
  const aiLine = [
    ai.data ? t("aiConnections", { count: ai.data.total }) : null,
    search.data ? (searchApp ? t("searchApp", { name: searchApp.appName }) : t("searchBuiltIn")) : null,
  ].filter(Boolean).join(" · ");
  return (
    <SettingsPage page="integrations">
      <SettingsSubPages
        page="integrations"
        states={{
          tracking,
          orderTools: [fraudLine, t("scanner")].filter(Boolean).join(" · "),
          aiApps: aiLine || null,
        }}
      />
    </SettingsPage>
  );
}
