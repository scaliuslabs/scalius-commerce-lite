import { useState } from "react";
import { createFileRoute, Link, Outlet, useMatch, useNavigate } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { IndexTabs } from "~/components/admin/resource/IndexTabs";
import { downloadOrderExport } from "~/components/admin/order-list/order-export";
import {
  effectiveOrderFilters,
  orderViewUpdates,
  type OrderListSearch,
  type OrderView,
} from "~/components/admin/order-list/order-list-search";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderMessages } from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import { orderListMessages } from "~/i18n/order-list";

/** Orders frame: one header and one card whose tabs switch between orders and abandoned checkouts. */
export const Route = createFileRoute("/admin/orders/_list")({
  component: OrdersFrame,
});

type OrdersTab = "all" | OrderView | "abandoned";

function ExportOrdersButton({ search }: { search: OrderListSearch | undefined }) {
  const t = useMessages(orderListMessages);
  const [busy, setBusy] = useState(false);
  const exportOrders = async () => {
    if (!search || busy) return;
    setBusy(true);
    try {
      const { rowCount, limited } = await downloadOrderExport(effectiveOrderFilters(search));
      toast.success(
        rowCount === null ? t("exported") : t("exportedCount", { count: rowCount }),
        limited ? { description: t("exportCapped") } : undefined,
      );
    } catch {
      toast.error(t("exportFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" disabled={!search || busy} onClick={() => void exportOrders()}>
      <Download className="h-4 w-4" />
      {t("export")}
    </Button>
  );
}

function OrdersFrame() {
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  const to = useMessages(orderMessages);
  const orderActions = useOrderActionPermissions();
  const navigate = useNavigate();
  const search = useMatch({ from: "/admin/orders/_list/", shouldThrow: false })?.search;
  const tab: OrdersTab = search ? (search.view ?? "all") : "abandoned";

  const selectTab = (next: OrdersTab) => {
    if (next === "abandoned") {
      void navigate({ to: "/admin/orders/abandoned" });
      return;
    }
    const updates = orderViewUpdates(next === "all" ? undefined : next);
    void navigate({
      to: "/admin/orders",
      search: search ? { ...search, ...updates } : updates,
    });
  };

  return (
    <>
      <PageHeader
        title={to("orders")}
        actions={
          <>
            <ExportOrdersButton search={search} />
            {orderActions.canCreateOrders ? (
              <Button asChild>
                <Link to="/admin/orders/new">{t("createOrder")}</Link>
              </Button>
            ) : null}
          </>
        }
      />
      <div className="overflow-hidden rounded-xl bg-card shadow-card">
        <IndexTabs<OrdersTab>
          label={t("views")}
          value={tab}
          onChange={selectTab}
          tabs={[
            { value: "all", label: tr("all") },
            { value: "unfulfilled", label: t("tab.unfulfilled") },
            { value: "unpaid", label: t("tab.unpaid") },
            { value: "abandoned", label: t("tab.abandoned") },
          ]}
        />
        <Outlet />
      </div>
    </>
  );
}
