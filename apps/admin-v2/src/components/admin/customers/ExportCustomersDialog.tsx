import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { useMessages } from "~/i18n";
import { customersMessages } from "~/i18n/customers";
import { resourceMessages } from "~/i18n/resource";
import {
  buildCustomerExportParams,
  CUSTOMER_EXPORT_MAX_IDS,
  CUSTOMER_EXPORT_MAX_ROWS,
  downloadCustomerExport,
  type CustomerExportFilters,
} from "./customer-export";

type Scope = "selected" | "filtered";

interface ExportCustomersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tab and filters of the list (never its search). */
  filters: CustomerExportFilters;
  /** Customers ticked in the list; empty when opened from the page header. */
  selectedIds: readonly string[];
  /** Customers matching the filters, when the list knows it. */
  total: number | null;
  /** A search narrows the list on screen; the export leaves it out (it never goes in a URL). */
  searchActive: boolean;
}

/** Export customers as CSV: the selection (up to 100) or everyone matching the list's tab and filters. */
export function ExportCustomersDialog({ open, onOpenChange, filters, selectedIds, total, searchActive }: ExportCustomersDialogProps) {
  const t = useMessages(customersMessages);
  const r = useMessages(resourceMessages);
  const [chosen, setChosen] = useState<Scope | null>(null);
  const [busy, setBusy] = useState(false);
  const hasSelection = selectedIds.length > 0;
  const selectionFits = hasSelection && selectedIds.length <= CUSTOMER_EXPORT_MAX_IDS;
  // Until the merchant picks, the scope follows how the dialog was opened.
  const scope: Scope = chosen === "selected" && !selectionFits ? "filtered" : chosen ?? (selectionFits ? "selected" : "filtered");
  const filtered = Boolean(filters.tag || filters.segmentId || filters.subscribed);
  const close = () => {
    if (busy) return;
    setChosen(null);
    onOpenChange(false);
  };

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { rowCount, limited } = await downloadCustomerExport(
        buildCustomerExportParams({ filters, ids: scope === "selected" ? selectedIds : null }),
      );
      toast.success(t("exported"), {
        description: limited
          ? t("exportCapped", { count: CUSTOMER_EXPORT_MAX_ROWS })
          : rowCount !== null ? t("exportedRows", { count: rowCount }) : undefined,
      });
      setChosen(null);
      onOpenChange(false);
    } catch {
      toast.error(t("exportFailed"));
    } finally {
      setBusy(false);
    }
  };

  const allLabel = filtered
    ? total !== null && !searchActive ? t("exportFilteredCount", { count: total }) : t("exportFiltered")
    : total !== null && !searchActive ? t("exportAllCount", { count: total }) : t("exportAll");

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("exportTitle")}</DialogTitle>
          <DialogDescription>{t("exportBody")}</DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-body font-medium">{t("exportScope")}</legend>
          <RadioGroup value={scope} onValueChange={(value) => setChosen(value as Scope)}>
            {hasSelection ? (
              <div className="flex items-center gap-2">
                <RadioGroupItem id="customer-export-selected" value="selected" disabled={!selectionFits} />
                <Label htmlFor="customer-export-selected">{t("exportSelected", { count: selectedIds.length })}</Label>
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <RadioGroupItem id="customer-export-filtered" value="filtered" />
              <Label htmlFor="customer-export-filtered">{allLabel}</Label>
            </div>
          </RadioGroup>
          {hasSelection && !selectionFits ? (
            <p className="text-body text-muted-foreground">{t("exportSelectedTooMany", { count: CUSTOMER_EXPORT_MAX_IDS })}</p>
          ) : null}
          {scope === "filtered" && searchActive ? (
            <p className="text-body text-muted-foreground">{t("exportSearchNote")}</p>
          ) : null}
          {scope === "filtered" && total !== null && total > CUSTOMER_EXPORT_MAX_ROWS ? (
            <p className="text-body text-muted-foreground">{t("exportCapped", { count: CUSTOMER_EXPORT_MAX_ROWS })}</p>
          ) : null}
        </fieldset>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={busy}>{r("cancel")}</Button>
          <Button type="button" loading={busy} onClick={() => void run()}>{t("exportCustomers")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
