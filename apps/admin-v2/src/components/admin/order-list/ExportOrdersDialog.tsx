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
import type { OrdersQuery } from "~/lib/api-query-options/orders";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { orderListMessages } from "~/i18n/order-list";
import {
  buildOrderExportParams,
  downloadOrderExport,
  ORDER_EXPORT_MAX_ROWS,
  type OrderExportFormat,
  type OrderExportScope,
} from "./order-export";

interface ExportOrdersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: Omit<OrdersQuery, "page" | "limit">;
  pageIds: readonly string[];
  selectedIds: readonly string[];
  /** Every order matching the filters is selected ("Select all N orders"). */
  allSelected: boolean;
  total: number;
}

/** Export orders as CSV: this page, every matching order or the selection; one row per order or per item. */
export function ExportOrdersDialog({
  open,
  onOpenChange,
  filters,
  pageIds,
  selectedIds,
  allSelected,
  total,
}: ExportOrdersDialogProps) {
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  // Until the merchant picks, the scope follows what they are looking at.
  const [chosenScope, setScope] = useState<OrderExportScope | null>(null);
  const [format, setFormat] = useState<OrderExportFormat>("summary");
  const [busy, setBusy] = useState(false);
  const canSelectScope = selectedIds.length > 0 && !allSelected;
  const scope = chosenScope && (chosenScope !== "selected" || canSelectScope)
    ? chosenScope
    : allSelected ? "all" : canSelectScope ? "selected" : "page";
  const close = () => {
    setScope(null);
    onOpenChange(false);
  };

  const run = async () => {
    if (busy) return;
    const ids = scope === "all" ? null : scope === "selected" ? selectedIds : pageIds;
    if (ids && ids.length === 0) return;
    setBusy(true);
    try {
      const { limited } = await downloadOrderExport(buildOrderExportParams({ filters, ids, format }));
      toast.success(t("exported"), limited ? { description: t("exportCapped", { count: ORDER_EXPORT_MAX_ROWS }) } : undefined);
      close();
    } catch {
      toast.error(t("exportFailed"));
    } finally {
      setBusy(false);
    }
  };

  const options: Array<{ value: OrderExportScope; label: string }> = [
    { value: "page", label: t("exportScope.page", { count: pageIds.length }) },
    { value: "all", label: t(total === 1 ? "exportScope.allOne" : "exportScope.all", { count: total }) },
    ...(canSelectScope ? [{ value: "selected" as const, label: t("exportScope.selected", { count: selectedIds.length }) }] : []),
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("exportTitle")}</DialogTitle>
          <DialogDescription>{t("exportBody")}</DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-body font-medium">{t("exportScope")}</legend>
          <RadioGroup value={scope} onValueChange={(value) => setScope(value as OrderExportScope)}>
            {options.map((option) => (
              <div key={option.value} className="flex items-center gap-2">
                <RadioGroupItem id={`export-scope-${option.value}`} value={option.value} />
                <Label htmlFor={`export-scope-${option.value}`}>{option.label}</Label>
              </div>
            ))}
          </RadioGroup>
          {scope === "all" && total > ORDER_EXPORT_MAX_ROWS ? (
            <p className="text-body text-muted-foreground">{t("exportCapped", { count: ORDER_EXPORT_MAX_ROWS })}</p>
          ) : null}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-body font-medium">{t("exportFormat")}</legend>
          <RadioGroup value={format} onValueChange={(value) => setFormat(value as OrderExportFormat)}>
            {(["summary", "items"] as const).map((value) => (
              <div key={value} className="flex items-center gap-2">
                <RadioGroupItem id={`export-format-${value}`} value={value} />
                <Label htmlFor={`export-format-${value}`}>{t(`exportFormat.${value}`)}</Label>
              </div>
            ))}
          </RadioGroup>
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            {tr("cancel")}
          </Button>
          <Button loading={busy} onClick={() => void run()}>
            {t("exportOrders")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
