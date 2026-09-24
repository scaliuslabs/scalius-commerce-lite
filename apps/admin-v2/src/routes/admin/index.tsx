import type { ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, CreditCard, Inbox, Package, Palette, Store, Truck } from "lucide-react";
import { getApiV1AdminInventoryAlerts, getApiV1AdminOrders } from "@scalius/api-client/sdk";
import { unixToDate } from "@scalius/shared/timestamps";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { statusBadgeVariant } from "~/components/admin/orderview/status-badges";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { DashboardSalesChart } from "~/components/admin/DashboardSalesChart";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { apiData } from "~/lib/api";
import { canAccessAdminPath } from "~/lib/admin-access";
import { RouteErrorComponent } from "~/lib/route-error";
import { dashboardActivityQueryOptions, dashboardSummaryQueryOptions } from "~/lib/api-query-options/dashboard-home";
import { formatDateTime, formatNumber, translate, useMessages } from "~/i18n";
import { homeMessages } from "~/i18n/home";

export const Route = createFileRoute("/admin/")({
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(dashboardSummaryQueryOptions());
    void queryClient.prefetchQuery(dashboardActivityQueryOptions());
  },
  head: () => ({ meta: [{ title: translate(homeMessages, "home") }] }),
  errorComponent: RouteErrorComponent,
  component: HomePage,
});

/** Today's date in store time (Asia/Dhaka) as YYYY-MM-DD, matching the activity feed. */
type HomeKey = keyof (typeof homeMessages)["en"];

const storeToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date());

function HomePage() {
  const t = useMessages(homeMessages);
  const to = useMessages(orderMessages);
  const { fmt } = useCurrency();
  const { permissions, isSuperAdmin } = usePermissions();
  const canOpen = (to: string) => canAccessAdminPath(to, { permissions, isSuperAdmin });
  const summary = useQuery(dashboardSummaryQueryOptions());
  const activity = useQuery(dashboardActivityQueryOptions());
  const openOrders = useQuery({
    queryKey: ["home", "open-orders"],
    queryFn: () => apiData(getApiV1AdminOrders({ query: { view: "unfulfilled", limit: 1 } })),
    enabled: canOpen("/admin/orders"),
  });
  const lowStock = useQuery({
    queryKey: ["home", "low-stock"],
    queryFn: () => apiData(getApiV1AdminInventoryAlerts({ query: { status: "active" } })),
    enabled: canOpen("/admin/inventory"),
  });

  if (summary.isError) {
    return (
      <div>
        <PageHeader title={t("home")} />
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
            {t("loadFailed")}
            <Button variant="outline" size="sm" onClick={() => void summary.refetch()}>{t("retry")}</Button>
          </CardHeader>
        </Card>
      </div>
    );
  }
  if (!summary.data) return <PageHeader title={t("home")} />;

  const { stats, recentOrders } = summary.data;
  if (stats.totalProducts === 0 && recentOrders.length === 0) return <SetupCards canOpen={canOpen} />;

  const days = (activity.data?.dailyActivityData ?? []).slice(-30);
  const today = days.find((day) => day.date === storeToday());
  const month = stats.currentMonth;
  const openCount = openOrders.data?.pagination.total ?? 0;
  const lowCount = lowStock.data?.alerts.length ?? 0;

  return (
    <div className="space-y-4 pb-8">
      <PageHeader title={t("home")} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label={t("salesToday")} value={fmt(today?.revenue ?? 0)} />
        <Metric label={t("ordersToday")} value={formatNumber(today?.orders ?? 0)} />
        <Metric label={t("salesThisMonth")} value={fmt(month.revenue)} change={month.revenueGrowth} />
        <Metric label={t("ordersThisMonth")} value={formatNumber(month.orders)} change={month.orderGrowth} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("salesChart")}</CardTitle>
        </CardHeader>
        <CardContent>
          {days.some((day) => day.revenue > 0) ? (
            <DashboardSalesChart days={days} money={fmt} />
          ) : (
            <p className="py-8 text-center text-body text-muted-foreground">{t("noSalesYet")}</p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>{t("recentOrders")}</CardTitle>
            {canOpen("/admin/orders") ? (
              <Button variant="ghost" size="sm" asChild>
                <Link to="/admin/orders">{t("viewAll")}</Link>
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="p-0">
            {recentOrders.length === 0 ? (
              <p className="px-4 pb-4 text-body text-muted-foreground">{t("noOrders")}</p>
            ) : (
              <ul className="divide-y border-t">
                {recentOrders.map((order) => {
                  const placed = unixToDate(order.createdAt);
                  return (
                    <li key={order.id}>
                      <Link
                        to="/admin/orders/$orderId"
                        params={{ orderId: order.id }}
                        className="flex min-h-11 items-center gap-3 px-4 py-2 text-body hover:bg-muted md:min-h-10"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{order.customerName}</span>
                          <span className="block text-muted-foreground">
                            {placed ? formatDateTime(placed, { dateStyle: "medium", timeStyle: "short" }) : null}
                          </span>
                        </span>
                        <Badge variant={statusBadgeVariant(order.status, "order")}>{orderStatusLabel(to, order.status)}</Badge>
                        <span className="tabular-nums">{fmt(order.totalAmount)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("toDo")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {openCount > 0 ? (
              <TodoLink to="/admin/orders" search={{ view: "unfulfilled" }} icon={<Inbox className="h-4 w-4" />}>
                {openCount === 1 ? t("orderToFulfil") : t("ordersToFulfil", { count: openCount })}
              </TodoLink>
            ) : null}
            {lowCount > 0 ? (
              <TodoLink to="/admin/inventory" search={{ section: "alerts" }} icon={<Package className="h-4 w-4" />}>
                {lowCount === 1 ? t("lowStockOne") : t("lowStock", { count: lowCount })}
              </TodoLink>
            ) : null}
            {openCount === 0 && lowCount === 0 ? <p className="text-body text-muted-foreground">{t("allDone")}</p> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Metric({ label, value, change }: { label: string; value: string; change?: number | null }) {
  const t = useMessages(homeMessages);
  return (
    <Card>
      <CardHeader className="space-y-1">
        <p className="text-body text-muted-foreground">{label}</p>
        <p className="text-heading-xl font-semibold tabular-nums">{value}</p>
        {/* Compare only against a real baseline: no badge when last month had nothing. */}
        {typeof change === "number" ? (
          <p className="text-body text-muted-foreground">
            {t("vsLastMonth", { change: `${formatNumber(Math.round(change), { signDisplay: "exceptZero" })}%` })}
          </p>
        ) : null}
      </CardHeader>
    </Card>
  );
}

function TodoLink({ to, search, icon, children }: { to: string; search: Record<string, string>; icon: ReactNode; children: ReactNode }) {
  return (
    <Link to={to} search={search as never} className="flex min-h-11 items-center gap-3 rounded-md px-2 text-body font-medium hover:bg-muted">
      {icon}
      <span className="flex-1">{children}</span>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </Link>
  );
}

const SETUP: ReadonlyArray<{ to: string; icon: typeof Package; title: HomeKey; body: HomeKey; action: HomeKey }> = [
  { to: "/admin/products/new", icon: Package, title: "setupProduct", body: "setupProductBody", action: "setupProductAction" },
  { to: "/admin/online-store/theme", icon: Palette, title: "setupTheme", body: "setupThemeBody", action: "setupThemeAction" },
  { to: "/admin/settings/payments", icon: CreditCard, title: "setupPayments", body: "setupPaymentsBody", action: "setupPaymentsAction" },
  { to: "/admin/settings/store", icon: Store, title: "setupStore", body: "setupStoreBody", action: "setupStoreAction" },
  { to: "/admin/settings/shipping", icon: Truck, title: "setupShipping", body: "setupShippingBody", action: "setupShippingAction" },
];

/** A store with no products and no orders yet: Shopify's setup cards. */
function SetupCards({ canOpen }: { canOpen: (to: string) => boolean }) {
  const t = useMessages(homeMessages);
  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-8">
      <div>
        <h1 className="text-heading-lg font-semibold">{t("welcome")}</h1>
        <p className="text-body text-muted-foreground">{t("welcomeBody")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {SETUP.filter((step) => canOpen(step.to)).map((step) => (
          <Card key={step.to}>
            <CardHeader className="space-y-3">
              <step.icon className="h-5 w-5 text-muted-foreground" />
              <div>
                <h2 className="font-semibold">{t(step.title)}</h2>
                <p className="text-body text-muted-foreground">{t(step.body)}</p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link to={step.to}>{t(step.action)}</Link>
              </Button>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
