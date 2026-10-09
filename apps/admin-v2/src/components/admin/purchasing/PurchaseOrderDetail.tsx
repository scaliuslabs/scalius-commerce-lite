import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "~/lib/toast";
import { ChevronDown, Download, Printer, XCircle } from "lucide-react";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useStoreIdentity } from "~/components/admin/layout/store-identity";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Progress } from "~/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { Textarea } from "~/components/ui/textarea";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { useCurrency } from "~/hooks/use-currency";
import { useIsMobile } from "~/hooks/use-mobile";
import { formatNumber, useLocale, useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { resourceMessages } from "~/i18n/resource";
import {
  usePurchaseOrderStatus,
  useSavePurchaseOrder,
  type PurchaseOrder,
} from "~/lib/api-query-options/purchasing";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { extraCostValid } from "./purchase-order-draft";
import { downloadPurchaseOrderCsv } from "./purchase-order-export";
import { printPurchaseOrder } from "./PurchaseOrderPrint";
import { formatDay, formatMoment, lineName } from "./purchasing-format";
import { PurchasingProblemBanner, readPurchasingProblem, type PurchasingProblem } from "./purchasing-problem";
import { isOpenPurchaseOrder, PurchaseOrderStatusBadge } from "./purchasing-status";
import { CostInput } from "~/components/admin/shared/MoneyInput";
import { Fact, LineProduct, SummaryRow, useUnitsText } from "./purchasing-ui";
import { SupplierPicker, type SupplierChoice } from "./SupplierPicker";
import { DateInput } from "~/components/ui/date-input";

type DialogName = "details" | "cancel" | null;

/**
 * A purchase order after it was ordered (or a draft for staff who can't
 * edit): what was ordered and what arrived, the receipts, the supplier and
 * the totals. Receive and Cancel act on it; the supplier, dates, reference,
 * notes and extra costs stay editable while units are still to come.
 */
export function PurchaseOrderDetail({ order, onReload }: { order: PurchaseOrder; onReload: () => Promise<void> }) {
  const t = useMessages(purchasingMessages);
  const { inventory: { canManageOperations: canEdit, canDraftPurchaseOrders, canViewCosts } } = useCatalogActionPermissions();
  const { fmt } = useCurrency();
  const locale = useLocale();
  const store = useStoreIdentity();
  const unitsText = useUnitsText();
  const status = usePurchaseOrderStatus();
  const [dialog, setDialog] = useState<DialogName>(null);
  const [detailsSession, setDetailsSession] = useState(0);
  const [problem, setProblem] = useState<PurchasingProblem | null>(null);
  const [reloading, setReloading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const open = isOpenPurchaseOrder(order.status);
  const cancellable = canEdit && (open || order.status === "draft");
  // The details carry the extra costs: editing them needs to see costs.
  const editable = canDraftPurchaseOrders && (open || order.status === "draft");
  const progress = order.quantity > 0 ? Math.round((order.receivedQuantity / order.quantity) * 100) : 0;

  const reload = async () => {
    setReloading(true);
    try {
      await onReload();
    } finally {
      setReloading(false);
    }
  };

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await downloadPurchaseOrderCsv(order);
    } catch {
      toast.error(t("exportFailed"));
    } finally {
      setExporting(false);
    }
  };

  const print = () => {
    const printed = printPurchaseOrder({ order, storeName: store.name || store.host, t, fmt, lang: locale });
    if (!printed) toast.error(t("popupBlocked"));
  };

  const cancel = () => {
    status.mutate({ id: order.id, revision: order.revision, action: "cancel" }, {
      onSuccess: () => {
        toast.success(t("purchaseOrderCancelled"));
        setProblem(null);
        setDialog(null);
      },
      onError: (error) => {
        setDialog(null);
        setProblem(readPurchasingProblem(error));
      },
    });
  };

  const editButton = editable ? (
    <Button
      type="button"
      variant="link"
      size="sm"
      onClick={() => {
        setDetailsSession((current) => current + 1);
        setDialog("details");
      }}
    >
      {t("edit")}
    </Button>
  ) : null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        backTo="/admin/inventory/purchase-orders"
        title={order.displayNumber}
        badge={<PurchaseOrderStatusBadge status={order.status} />}
        actions={(
          <>
            {/* The printout and the CSV are the supplier's copy, with every cost. */}
            {canViewCosts || cancellable ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" loading={exporting}>
                    {t("moreActions")}
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canViewCosts ? (
                    <>
                      <DropdownMenuItem onSelect={print}>
                        <Printer />
                        {t("print")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void exportCsv()}>
                        <Download />
                        {t("exportCsv")}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                  {cancellable ? (
                    <>
                      {canViewCosts ? <DropdownMenuSeparator /> : null}
                      <DropdownMenuItem variant="destructive" onSelect={() => setDialog("cancel")}>
                        <XCircle />
                        {t("cancelPurchaseOrder")}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {canEdit && open ? (
              <Button asChild>
                <Link to="/admin/inventory/purchase-orders/$purchaseOrderId/receive" params={{ purchaseOrderId: order.id }}>
                  {t("receive")}
                </Link>
              </Button>
            ) : null}
          </>
        )}
      />
      {!canEdit ? (
        <p role="status" className="mb-4 rounded-lg bg-muted px-4 py-2 text-body text-muted-foreground">{t("readOnly")}</p>
      ) : null}
      {problem ? (
        <div className="mb-4">
          <PurchasingProblemBanner
            problem={problem}
            staleText={t("purchaseOrderChanged")}
            failedText={t("purchaseOrderFailed")}
            onReload={() => void reload().then(() => setProblem(null))}
            reloading={reloading}
          />
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card>
            <CardHeader className="gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <CardTitle>{t("products")}</CardTitle>
                <span className="text-body text-muted-foreground tabular-nums">
                  {t("receivedProgress", { received: order.receivedQuantity, total: order.quantity })}
                </span>
              </div>
              <Progress value={progress} aria-label={t("receivedProgress", { received: order.receivedQuantity, total: order.quantity })} />
            </CardHeader>
            <PurchaseOrderLines order={order} showCosts={canViewCosts} />
          </Card>
          <ReceiptsCard order={order} showCosts={canViewCosts} />
        </div>

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle>{t("supplier")}</CardTitle>
              {editButton}
            </CardHeader>
            <CardContent className="space-y-0.5">
              {order.supplier ? (
                <>
                  <p className="text-body font-medium">{order.supplier.name}</p>
                  {order.supplier.contactName ? <p className="text-body">{order.supplier.contactName}</p> : null}
                  {order.supplier.phone ? <p className="font-mono text-body">{order.supplier.phone}</p> : null}
                  {order.supplier.email ? <p className="break-all text-body text-muted-foreground">{order.supplier.email}</p> : null}
                </>
              ) : (
                <p className="text-body text-muted-foreground">{t("noSupplier")}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle>{t("details")}</CardTitle>
              {editButton}
            </CardHeader>
            <CardContent>
              <dl className="space-y-3">
                <Fact label={t("destination")}>{order.destination.name}</Fact>
                <Fact label={t("expectedArrival")}>{formatDay(order.expectedOn) ?? t("notSet")}</Fact>
                <Fact label={t("reference")}>{order.reference ?? t("none")}</Fact>
                <Fact label={t("createdOn")}>{formatMoment(order.createdAt) ?? "—"}</Fact>
                {order.orderedAt ? <Fact label={t("orderedOn")}>{formatMoment(order.orderedAt)}</Fact> : null}
                {order.receivedAt ? <Fact label={t("receivedOn")}>{formatMoment(order.receivedAt)}</Fact> : null}
                {order.cancelledAt ? <Fact label={t("cancelledOn")}>{formatMoment(order.cancelledAt)}</Fact> : null}
              </dl>
            </CardContent>
          </Card>

          {canViewCosts ? (
            <Card>
              <CardHeader>
                <CardTitle>{t("costSummary")}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="space-y-3">
                  <SummaryRow label={t("subtotal")} detail={unitsText(order.quantity)}>{fmt(order.subtotal ?? 0)}</SummaryRow>
                  <SummaryRow label={t("shipping")}>{fmt(order.shipping ?? 0)}</SummaryRow>
                  <SummaryRow label={t("otherCosts")}>{fmt(order.otherCosts ?? 0)}</SummaryRow>
                  <SummaryRow label={t("tax")}>{fmt(order.tax ?? 0)}</SummaryRow>
                  <div className="border-t pt-3">
                    <SummaryRow label={t("total")} strong>{fmt(order.total ?? 0)}</SummaryRow>
                  </div>
                </dl>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{t("notes")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className={order.notes ? "whitespace-pre-wrap break-words text-body" : "text-body text-muted-foreground"}>
                {order.notes ?? t("none")}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      <PurchaseOrderDetailsDialog
        key={detailsSession}
        order={order}
        open={dialog === "details" && editable}
        onOpenChange={(next) => setDialog(next ? "details" : null)}
        onReload={reload}
      />
      <ConfirmDialog
        open={dialog === "cancel" && cancellable}
        onOpenChange={(next) => { if (!next && !status.isPending) setDialog(null); }}
        title={t("cancelPurchaseOrderTitle", { number: order.displayNumber })}
        description={t("cancelPurchaseOrderBody")}
        confirmLabel={t("cancelPurchaseOrder")}
        cancelLabel={t("keepPurchaseOrder")}
        isLoading={status.isPending}
        onConfirm={cancel}
      />
    </div>
  );
}

/** Ordered, received and (with "View product costs") cost per line. */
function PurchaseOrderLines({ order, showCosts }: { order: PurchaseOrder; showCosts: boolean }) {
  const t = useMessages(purchasingMessages);
  const { fmt } = useCurrency();
  const isMobile = useIsMobile();
  const costHint = (line: PurchaseOrder["lines"][number]) =>
    line.currentCost != null && line.currentCost !== line.unitCost
      ? <span className="block text-muted-foreground">{t("costNow", { amount: fmt(line.currentCost) })}</span>
      : null;

  if (isMobile) {
    return (
      <ul className="divide-y border-t">
        {order.lines.map((line) => (
          <li key={line.id} className="space-y-1 px-4 py-3">
            <LineProduct line={line} retired={line.retired} />
            <p className="flex flex-wrap justify-between gap-x-4 text-body tabular-nums">
              <span className="text-muted-foreground">{t("receivedOf", { received: line.receivedQuantity, total: line.quantity })}</span>
              {showCosts ? <span>{formatNumber(line.quantity)} × {fmt(line.unitCost ?? 0)} = {fmt(line.lineTotal ?? 0)}</span> : null}
            </p>
            {showCosts ? <p className="text-body tabular-nums">{costHint(line)}</p> : null}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="border-t">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("colProduct")}</TableHead>
            <TableHead data-numeric="">{t("colReceived")}</TableHead>
            {showCosts ? <TableHead data-numeric="">{t("colCost")}</TableHead> : null}
            {showCosts ? <TableHead data-numeric="">{t("colLineTotal")}</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {order.lines.map((line) => (
            <TableRow key={line.id}>
              <TableCell className="py-2"><LineProduct line={line} retired={line.retired} /></TableCell>
              <TableCell data-numeric="">{t("receivedOf", { received: line.receivedQuantity, total: line.quantity })}</TableCell>
              {showCosts ? (
                <TableCell data-numeric="">
                  {fmt(line.unitCost ?? 0)}
                  {costHint(line)}
                </TableCell>
              ) : null}
              {showCosts ? <TableCell data-numeric="">{fmt(line.lineTotal ?? 0)}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Each receipt, newest first: when, who, which lines, and any cost it moved. */
function ReceiptsCard({ order, showCosts }: { order: PurchaseOrder; showCosts: boolean }) {
  const t = useMessages(purchasingMessages);
  const { fmt } = useCurrency();
  const lines = new Map(order.lines.map((line) => [line.id, line]));
  const receipts = [...order.receipts].reverse();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("receipts")}</CardTitle>
      </CardHeader>
      {receipts.length === 0 ? (
        <CardContent><p className="text-body text-muted-foreground">{t("noReceipts")}</p></CardContent>
      ) : (
        <ul className="divide-y border-t">
          {receipts.map((receipt) => (
            <li key={receipt.operationKey} className="space-y-1 px-4 py-3">
              <p className="text-body text-muted-foreground">
                {t("receiptBy", { date: formatMoment(receipt.createdAt) ?? "—", name: receipt.actorName })}
              </p>
              <ul className="space-y-1">
                {receipt.lines.map((entry) => {
                  const line = lines.get(entry.lineId);
                  return (
                    <li key={entry.lineId} className="flex flex-wrap items-baseline justify-between gap-x-4 text-body">
                      <span className="min-w-0">
                        {line ? lineName(line, t("unknownProduct")) : null}{" "}
                        <span className="font-mono text-muted-foreground">{entry.sku}</span>
                      </span>
                      <span className="tabular-nums">
                        {t("receiptLine", { count: entry.quantity })}
                        {showCosts && entry.costUpdated && entry.costBefore !== entry.costAfter && entry.costAfter != null ? (
                          <span className="text-muted-foreground">
                            {" · "}
                            {t("costChange", { before: entry.costBefore == null ? "—" : fmt(entry.costBefore), after: fmt(entry.costAfter) })}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * The fields that stay editable once ordered: supplier, expected date,
 * reference, notes and the extra costs. Re-keyed per opening.
 */
function PurchaseOrderDetailsDialog({ order, open, onOpenChange, onReload }: {
  order: PurchaseOrder;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReload: () => Promise<void>;
}) {
  const t = useMessages(purchasingMessages);
  const r = useMessages(resourceMessages);
  const decimals = getDecimalPlaces(order.currencyCode);
  const save = useSavePurchaseOrder();
  const [supplier, setSupplier] = useState<SupplierChoice | null>(order.supplier ? { id: order.supplier.id, name: order.supplier.name } : null);
  const [expectedOn, setExpectedOn] = useState(order.expectedOn ?? "");
  const [reference, setReference] = useState(order.reference ?? "");
  const [notes, setNotes] = useState(order.notes ?? "");
  const [costs, setCosts] = useState<Record<"shipping" | "otherCosts" | "tax", number | null>>({
    shipping: order.shipping || null,
    otherCosts: order.otherCosts || null,
    tax: order.tax || null,
  });
  const [problem, setProblem] = useState<PurchasingProblem | null>(null);
  const [reloading, setReloading] = useState(false);
  const costsValid = Object.values(costs).every((cost) => extraCostValid(cost, decimals));
  // The revision the dialog opened on: a newer one elsewhere is a conflict, not an overwrite.
  const [revision] = useState(order.revision);

  const submit = () => {
    if (!costsValid || save.isPending) return;
    setProblem(null);
    save.mutate(
      {
        id: order.id,
        revision,
        body: {
          supplierId: supplier?.id ?? null,
          expectedOn: expectedOn || null,
          reference: reference.trim() || null,
          notes: notes.trim() || null,
          shipping: costs.shipping ?? 0,
          otherCosts: costs.otherCosts ?? 0,
          tax: costs.tax ?? 0,
        },
      },
      {
        onSuccess: () => {
          toast.success(t("detailsSaved"));
          onOpenChange(false);
        },
        onError: (error) => setProblem(readPurchasingProblem(error)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!save.isPending) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editDetails")}</DialogTitle>
          <DialogDescription>{order.displayNumber}</DialogDescription>
        </DialogHeader>
        <form
          id="purchase-order-details-form"
          method="post"
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <PurchasingProblemBanner
            problem={problem}
            staleText={t("purchaseOrderChanged")}
            failedText={t("purchaseOrderSaveFailed")}
            reloading={reloading}
            onReload={() => {
              setReloading(true);
              void onReload().finally(() => {
                setReloading(false);
                onOpenChange(false);
              });
            }}
          />
          <div className="space-y-2">
            <Label htmlFor="po-details-supplier">{t("supplier")}</Label>
            <SupplierPicker id="po-details-supplier" value={supplier} onChange={setSupplier} canAdd />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="po-details-expected">{t("expectedArrival")}</Label>
              <DateInput id="po-details-expected" value={expectedOn} onValueChange={setExpectedOn} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="po-details-reference">{t("reference")}</Label>
              <Input
                id="po-details-reference"
                maxLength={100}
                autoComplete="off"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {(["shipping", "otherCosts", "tax"] as const).map((key) => (
              <div key={key} className="space-y-2">
                <Label htmlFor={`po-details-${key}`}>{t(key)}</Label>
                <CostInput
                  id={`po-details-${key}`}
                  value={costs[key]}
                  placeholder="0"
                  aria-invalid={extraCostValid(costs[key], decimals) ? undefined : true}
                  onValueChange={(value) => setCosts((current) => ({ ...current, [key]: value }))}
                />
              </div>
            ))}
          </div>
          {!costsValid ? <p className="text-body text-destructive">{t("fixCosts")}</p> : null}
          <div className="space-y-2">
            <Label htmlFor="po-details-notes">{t("notes")}</Label>
            <Textarea id="po-details-notes" rows={3} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </div>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>{r("cancel")}</Button>
          <Button type="submit" form="purchase-order-details-form" disabled={!costsValid} loading={save.isPending}>{r("save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
