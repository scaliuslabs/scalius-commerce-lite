import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "~/lib/toast";
import { Truck } from "lucide-react";
import { createActionsColumn } from "~/components/admin/data-table/columns/column-factories";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Button } from "~/components/ui/button";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { suppliersQueryOptions, useSupplierAction, type Supplier } from "~/lib/api-query-options/purchasing";
import { DocumentList } from "./DocumentList";
import { SUPPLIER_TABS, supplierListQuery, type SupplierTab } from "./purchasing-list-state";
import { PurchasingProblemBanner, readPurchasingProblem, type PurchasingProblem } from "./purchasing-problem";
import { SupplierDialog } from "./SupplierDialog";

/** Who the store buys from: add, edit, archive (never delete: past purchase orders keep them). */
export function SupplierList({ tab, onTabChange }: { tab: SupplierTab; onTabChange: (tab: SupplierTab) => void }) {
  const t = useMessages(purchasingMessages);
  const { inventory: { canManageOperations: canEdit } } = useCatalogActionPermissions();
  const action = useSupplierAction();
  // The last supplier opened stays set while its dialog closes, so the dialog never jumps.
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [session, setSession] = useState(0);
  const [archiving, setArchiving] = useState<Supplier | null>(null);
  const [problem, setProblem] = useState<{ kind: "archive" | "unarchive"; problem: PurchasingProblem } | null>(null);

  const openEditor = (supplier: Supplier | null) => {
    setEditing(supplier);
    setSession((current) => current + 1);
    setEditOpen(true);
  };

  const run = (supplier: Supplier, kind: "archive" | "unarchive") => {
    setProblem(null);
    action.mutate({ id: supplier.id, action: kind }, {
      onSuccess: () => {
        setArchiving(null);
        toast.success(t(kind === "archive" ? "supplierArchived" : "supplierUnarchived"));
      },
      onError: (error) => {
        setArchiving(null);
        setProblem({ kind, problem: readPurchasingProblem(error) });
      },
    });
  };

  const columns = useMemo<ColumnDef<Supplier, unknown>[]>(() => [
    {
      id: "name",
      header: t("colName"),
      meta: { primary: true, mobile: "primary", minWidth: 200 },
      cell: ({ row }) => canEdit ? (
        <button
          type="button"
          title={row.original.name}
          className="block max-w-full truncate text-start font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => openEditor(row.original)}
        >
          {row.original.name}
        </button>
      ) : (
        <span className="block truncate font-medium" title={row.original.name}>{row.original.name}</span>
      ),
    },
    {
      id: "contact",
      header: t("colContact"),
      meta: { mobile: "secondary", priority: 80, minWidth: 180 },
      cell: ({ row }) => {
        const parts = [row.original.contactName, row.original.phone].filter(Boolean);
        return parts.length > 0
          ? <span className="block truncate" title={parts.join(" · ")}>{parts.join(" · ")}</span>
          : <span className="text-muted-foreground">—</span>;
      },
    },
    {
      id: "email",
      header: t("colEmail"),
      meta: { priority: 50, minWidth: 180 },
      cell: ({ row }) => row.original.email
        ? <span className="block truncate" title={row.original.email}>{row.original.email}</span>
        : <span className="text-muted-foreground">—</span>,
    },
    {
      id: "open",
      header: t("colOpenPurchaseOrders"),
      meta: { numeric: true, mobile: "secondary", priority: 70, minWidth: 140 },
      cell: ({ row }) => row.original.openPurchaseOrders > 0 ? (
        <Link
          to="/admin/inventory/purchase-orders"
          search={{ status: "open", supplier: row.original.id }}
          className="text-link hover:underline"
        >
          {t("openPurchaseOrdersLink", { count: row.original.openPurchaseOrders })}
        </Link>
      ) : <span className="text-muted-foreground">—</span>,
    },
    ...(canEdit ? [createActionsColumn<Supplier>({
      showTrashed: false,
      onEdit: (supplier) => openEditor(supplier),
      getMenuLabel: (supplier) => t("actionsFor", { name: supplier.name }),
      getExtraActions: (supplier) => [supplier.status === "active"
        ? { label: t("archive"), destructive: true, onClick: () => setArchiving(supplier) }
        : { label: t("unarchive"), onClick: () => run(supplier, "unarchive") }],
    })] : []),
    // openEditor and run only set state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [canEdit, t]);

  const addButton = canEdit ? <Button type="button" onClick={() => openEditor(null)}>{t("addSupplier")}</Button> : null;

  return (
    <>
      <DocumentList<Supplier, SupplierTab>
        title={t("suppliers")}
        actions={(
          <>
            <Button asChild variant="outline">
              <Link to="/admin/inventory/purchase-orders">{t("purchaseOrders")}</Link>
            </Button>
            {addButton}
          </>
        )}
        notice={problem ? (
          <PurchasingProblemBanner
            problem={problem.problem}
            staleText={t("supplierChanged")}
            failedText={t(problem.kind === "archive" ? "archiveFailed" : "unarchiveFailed")}
          />
        ) : null}
        tabs={SUPPLIER_TABS.map((value) => ({ value, label: t(value === "active" ? "tabActive" : "tabArchived") }))}
        tab={tab}
        onTabChange={onTabChange}
        searchKey="suppliers"
        searchPlaceholder={t("searchSuppliers")}
        query={(term, page, limit) => suppliersQueryOptions(supplierListQuery(tab, term, page, limit))}
        dataKey="suppliers"
        columns={columns}
        layoutKey="inventory-suppliers"
        itemLabel={t("suppliersItem")}
        empty={{
          icon: Truck,
          title: t("emptySuppliersTitle"),
          description: t("emptySuppliersBody"),
          action: addButton ?? undefined,
        }}
      />
      <SupplierDialog key={session} supplier={editing} open={editOpen && canEdit} onOpenChange={setEditOpen} />
      <ConfirmDialog
        open={archiving !== null && canEdit}
        onOpenChange={(open) => { if (!open && !action.isPending) setArchiving(null); }}
        title={t("archiveTitle", { name: archiving?.name ?? "" })}
        description={t("archiveBody")}
        confirmLabel={t("archive")}
        isLoading={action.isPending}
        onConfirm={() => { if (archiving) run(archiving, "archive"); }}
      />
    </>
  );
}
