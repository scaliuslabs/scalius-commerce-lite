import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "~/lib/toast";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { Button } from "~/components/ui/button";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { storeTransferMessages } from "~/i18n/store-transfer";
import { SettingsCard } from "../settings/SettingsPage";
import { ExportCustomersDialog } from "../customers/ExportCustomersDialog";
import { ImportDialog } from "./ImportDialog";
import { downloadPagedExport, type PagedExport } from "./export-download";
import type { ImportKind } from "./import-plan";

function HubRow({ title, description, action }: { title: string; description: string; action: ReactNode }) {
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-3 border-t border-border px-4 py-3 first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium">{title}</p>
        <p className="text-body text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

/** Settings → Import and export: every import and export in one place. */
export function ImportExportHub() {
  const t = useMessages(storeTransferMessages);
  const { hasPermission } = usePermissions();
  const [importing, setImporting] = useState<ImportKind | null>(null);
  const [exporting, setExporting] = useState<PagedExport | null>(null);
  const [exportRows, setExportRows] = useState(0);
  const [customersOpen, setCustomersOpen] = useState(false);

  const canImportProducts = hasPermission(PERMISSIONS.PRODUCTS_CREATE) || hasPermission(PERMISSIONS.PRODUCTS_EDIT);
  const canImportCustomers = hasPermission(PERMISSIONS.CUSTOMERS_CREATE) || hasPermission(PERMISSIONS.CUSTOMERS_EDIT);
  const canImportInventory = hasPermission(PERMISSIONS.PRODUCTS_ADJUST_STOCK);
  const canViewProducts = hasPermission(PERMISSIONS.PRODUCTS_VIEW);

  const runExport = async (kind: PagedExport) => {
    if (exporting) return;
    setExporting(kind);
    setExportRows(0);
    try {
      const rows = await downloadPagedExport(kind, setExportRows);
      toast.success(t("exported"), { description: t("exportedRows", { count: rows }) });
    } catch {
      toast.error(t("exportFailed"));
    } finally {
      setExporting(null);
    }
  };

  const importButton = (kind: ImportKind, allowed: boolean) => allowed
    ? <Button type="button" variant="outline" onClick={() => setImporting(kind)}>{t("import")}</Button>
    : null;
  const exportButton = (kind: PagedExport) => canViewProducts
    ? (
      <Button type="button" variant="outline" loading={exporting === kind} disabled={exporting !== null && exporting !== kind} onClick={() => void runExport(kind)}>
        {t("export")}
      </Button>
    )
    : null;

  return (
    <>
      <p className="text-body text-muted-foreground">{t("hubIntro")}</p>
      <SettingsCard
        title={t("importsTitle")}
        rows={(
          <>
            <HubRow title={t("hubProducts")} description={t("hubProductsImport")} action={importButton("products", canImportProducts)} />
            <HubRow title={t("hubCustomers")} description={t("hubCustomersImport")} action={importButton("customers", canImportCustomers)} />
            <HubRow title={t("hubInventory")} description={t("hubInventoryImport")} action={importButton("inventory", canImportInventory)} />
          </>
        )}
      />
      <SettingsCard
        title={t("exportsTitle")}
        description={exporting ? t("exporting", { count: exportRows }) : undefined}
        rows={(
          <>
            <HubRow title={t("hubProducts")} description={t("hubProductsExport")} action={exportButton("products")} />
            <HubRow title={t("hubInventory")} description={t("hubInventoryExport")} action={exportButton("inventory")} />
            <HubRow
              title={t("hubCustomers")}
              description={t("hubCustomersExport")}
              action={hasPermission(PERMISSIONS.CUSTOMERS_VIEW) ? <Button type="button" variant="outline" onClick={() => setCustomersOpen(true)}>{t("export")}</Button> : null}
            />
            <HubRow
              title={t("hubOrders")}
              description={t("hubOrdersExport")}
              action={hasPermission(PERMISSIONS.ORDERS_VIEW) ? <Button type="button" variant="outline" asChild><Link to="/admin/orders">{t("openOrders")}</Link></Button> : null}
            />
          </>
        )}
      />
      {/* One dialog per kind, so a session never carries another kind's file or mode. */}
      <ImportDialog key={importing ?? "closed"} kind={importing ?? "products"} open={importing !== null} onOpenChange={(open) => { if (!open) setImporting(null); }} />
      <ExportCustomersDialog open={customersOpen} onOpenChange={setCustomersOpen} filters={{}} selectedIds={[]} total={null} searchActive={false} />
    </>
  );
}
