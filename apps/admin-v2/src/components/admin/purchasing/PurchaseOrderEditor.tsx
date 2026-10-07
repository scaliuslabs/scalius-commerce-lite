import { useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
import { X } from "lucide-react";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { NumberInput } from "~/components/ui/number-input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { Textarea } from "~/components/ui/textarea";
import { useCurrency } from "~/hooks/use-currency";
import { useIsMobile } from "~/hooks/use-mobile";
import { useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { resourceMessages } from "~/i18n/resource";
import { inventoryLocationsQueryOptions } from "~/lib/api-query-options/inventory-locations";
import {
  PURCHASING_MAX_LINES,
  useDeletePurchaseOrder,
  usePurchaseOrderStatus,
  useSavePurchaseOrder,
  type PurchaseOrder,
} from "~/lib/api-query-options/purchasing";
import { documentTotals, lineTotal } from "./document-math";
import {
  draftBody,
  draftFingerprint,
  draftFromOrder,
  lineFromVariant,
  validateDraft,
  type DraftValidation,
  type PurchaseOrderDraft,
  type PurchaseOrderDraftLine,
} from "./purchase-order-draft";
import { lineName } from "./purchasing-format";
import { PurchasingProblemBanner, readPurchasingProblem, type PurchasingProblem } from "./purchasing-problem";
import { PurchaseOrderStatusBadge } from "./purchasing-status";
import { CostInput, LineProduct, SummaryRow, useUnitsText } from "./purchasing-ui";
import { SkuPicker } from "./SkuPicker";
import { SupplierPicker } from "./SupplierPicker";
import { DateInput } from "~/components/ui/date-input";

type Busy = "save" | "order" | null;

/**
 * Create a purchase order or edit its draft (Shopify's PO editor): supplier,
 * destination, shipment details, the products with quantity and cost per
 * item, the extra costs and the totals. Save draft keeps it editable; Mark as
 * ordered saves any edits first, then makes its lines incoming stock.
 */
export function PurchaseOrderEditor({ order, onReload }: {
  /** The draft being edited; null creates one. */
  order: PurchaseOrder | null;
  /** Reads the latest copy and starts the editor again from it (after a conflict). */
  onReload?: () => Promise<void>;
}) {
  const t = useMessages(purchasingMessages);
  const navigate = useNavigate();
  const { fmt, code } = useCurrency();
  const decimals = getDecimalPlaces(order?.currencyCode ?? code);
  const unitsText = useUnitsText();
  const locations = useQuery(inventoryLocationsQueryOptions()).data;
  const activeLocations = useMemo(() => locations?.filter((location) => location.status === "active") ?? [], [locations]);
  const defaultLocation = activeLocations.find((location) => location.isDefault) ?? activeLocations[0] ?? null;

  const [draft, setDraft] = useState<PurchaseOrderDraft>(() => draftFromOrder(order));
  const [savedFingerprint, setSavedFingerprint] = useState(() => draftFingerprint(draftFromOrder(order)));
  // The revision this editor started from (or last saved): a newer one elsewhere is a conflict.
  const [revision, setRevision] = useState<number | null>(order?.revision ?? null);
  const [showErrors, setShowErrors] = useState(false);
  const [problem, setProblem] = useState<PurchasingProblem | null>(null);
  const [failedAction, setFailedAction] = useState<Exclude<Busy, null>>("save");
  const [busy, setBusy] = useState<Busy>(null);
  const [reloading, setReloading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Set (and rendered) before leaving a deleted draft, so the unsaved-changes guard lets the page go.
  const [leaving, setLeaving] = useState(false);
  const save = useSavePurchaseOrder();
  const status = usePurchaseOrderStatus();
  const remove = useDeletePurchaseOrder();

  const dirty = draftFingerprint(draft) !== savedFingerprint;
  const validation = validateDraft(draft, decimals);
  const totals = documentTotals(draft.lines, [draft.shipping, draft.otherCosts, draft.tax], decimals);
  const update = (patch: Partial<PurchaseOrderDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const destinationId = draft.destinationId || order?.destination.id || defaultLocation?.id || "";
  const destinationName = activeLocations.find((location) => location.id === destinationId)?.name
    ?? order?.destination.name
    ?? defaultLocation?.name
    ?? "";

  const openDetail = (id: string) =>
    navigate({ to: "/admin/inventory/purchase-orders/$purchaseOrderId", params: { purchaseOrderId: id }, replace: true });

  /** Saves the draft as it is now; the sent copy becomes the saved one. */
  const saveNow = async () => {
    const sent = draft;
    const result = await save.mutateAsync({ id: order?.id ?? null, revision, body: draftBody(sent) });
    setSavedFingerprint(draftFingerprint(sent));
    setRevision(result.revision);
    return result;
  };

  const saveDraft = async () => {
    if (busy) return;
    if (!validation.valid) {
      setShowErrors(true);
      return;
    }
    setBusy("save");
    setProblem(null);
    try {
      const result = await saveNow();
      toast.success(t(order ? "draftSaved" : "draftCreated"));
      if (!order) await openDetail(result.id);
    } catch (error) {
      setFailedAction("save");
      setProblem(readPurchasingProblem(error));
    } finally {
      setBusy(null);
    }
  };

  const markOrdered = async () => {
    if (busy) return;
    if (draft.lines.length === 0) {
      setProblem({ kind: "refused", message: t("needLines") });
      return;
    }
    if (!validation.valid) {
      setShowErrors(true);
      return;
    }
    setBusy("order");
    setProblem(null);
    let createdId: string | null = null;
    try {
      let id = order?.id ?? null;
      let current = revision;
      if (!order || dirty) {
        const result = await saveNow();
        id = result.id;
        current = result.revision;
        if (!order) createdId = result.id;
      }
      await status.mutateAsync({ id: id!, revision: current!, action: "order" });
      toast.success(t("markedOrdered"));
      if (!order) await openDetail(id!);
    } catch (error) {
      const next = readPurchasingProblem(error);
      if (createdId) {
        // The draft exists now: open it, and say why it isn't ordered yet.
        toast.error(next.kind === "refused" ? next.message : t("purchaseOrderFailed"));
        await openDetail(createdId);
      } else {
        setFailedAction("order");
        setProblem(next);
      }
    } finally {
      setBusy(null);
    }
  };

  const reload = async () => {
    if (!onReload) return;
    setReloading(true);
    try {
      await onReload();
    } finally {
      setReloading(false);
    }
  };

  const deleteDraft = () => {
    if (!order || revision === null) return;
    remove.mutate({ id: order.id, revision }, {
      onSuccess: () => {
        toast.success(t("draftDeleted"));
        flushSync(() => {
          setConfirmDelete(false);
          setLeaving(true);
        });
        void navigate({ to: "/admin/inventory/purchase-orders" });
      },
      onError: (error) => {
        setConfirmDelete(false);
        setProblem(readPurchasingProblem(error));
      },
    });
  };

  const addedIds = useMemo(() => new Set(draft.lines.map((line) => line.variantId)), [draft.lines]);
  const updateLine = (variantId: string, patch: Partial<PurchaseOrderDraftLine>) =>
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.variantId === variantId ? { ...line, ...patch } : line)),
    }));

  const extraField = (key: "shipping" | "otherCosts" | "tax") => (
    <div className="flex items-center justify-between gap-4">
      <Label htmlFor={`po-${key}`}>{t(key)}</Label>
      <div className="space-y-1">
        <CostInput
          id={`po-${key}`}
          className="w-36"
          value={draft[key]}
          placeholder="0"
          aria-invalid={showErrors && validation.extras[key] ? true : undefined}
          onValueChange={(value) => update({ [key]: value })}
        />
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl">
      <UnsavedChangesGuard isDirty={dirty && !leaving} isSubmitting={busy !== null || remove.isPending} />
      <PageHeader
        backTo="/admin/inventory/purchase-orders"
        title={order?.displayNumber ?? t("newPurchaseOrder")}
        badge={order ? <PurchaseOrderStatusBadge status={order.status} /> : null}
        actions={(
          <>
            {order ? (
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
                {t("deleteDraft")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              loading={busy === "save"}
              disabled={busy !== null || (order !== null && !dirty)}
              onClick={() => void saveDraft()}
            >
              {t("saveDraft")}
            </Button>
            <Button type="button" loading={busy === "order"} disabled={busy !== null} onClick={() => void markOrdered()}>
              {t("markOrdered")}
            </Button>
          </>
        )}
      />
      {problem ? (
        <div className="mb-4">
          <PurchasingProblemBanner
            problem={problem}
            staleText={t("purchaseOrderChanged")}
            failedText={t(failedAction === "order" ? "purchaseOrderFailed" : "purchaseOrderSaveFailed")}
            onReload={onReload ? () => void reload() : undefined}
            reloading={reloading}
          />
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card>
            <CardContent className="grid gap-4 pt-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="po-supplier">{t("supplier")}</Label>
                <SupplierPicker
                  id="po-supplier"
                  value={draft.supplier}
                  onChange={(supplier) => update({ supplier })}
                  canAdd
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={activeLocations.length > 1 ? "po-destination" : undefined}>{t("destination")}</Label>
                {activeLocations.length > 1 ? (
                  <SearchableSelect
                    id="po-destination"
                    triggerClassName="w-full"
                    value={destinationId}
                    onValueChange={(value) => {
                      if (activeLocations.some((location) => location.id === value)) update({ destinationId: value });
                    }}
                    options={activeLocations.map((location) => ({ value: location.id, label: location.name }))}
                  />
                ) : (
                  <p className="flex min-h-9 items-center text-body">{destinationName || "—"}</p>
                )}
                <p className="text-body text-muted-foreground">{t("destinationHelp")}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("shipmentDetails")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="po-expected">{t("expectedArrival")}</Label>
                <DateInput
                  id="po-expected"
                  value={draft.expectedOn}
                  onValueChange={(expectedOn) => update({ expectedOn })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="po-reference">{t("reference")}</Label>
                <Input
                  id="po-reference"
                  maxLength={100}
                  autoComplete="off"
                  value={draft.reference}
                  aria-describedby="po-reference-help"
                  onChange={(event) => update({ reference: event.target.value })}
                />
                <p id="po-reference-help" className="text-body text-muted-foreground">{t("referenceHelp")}</p>
              </div>
            </CardContent>
          </Card>

          <PurchaseOrderLinesCard
            lines={draft.lines}
            addedIds={addedIds}
            validation={validation}
            showErrors={showErrors}
            decimals={decimals}
            onAdd={(variant) => setDraft((current) => (
              current.lines.some((line) => line.variantId === variant.id) || current.lines.length >= PURCHASING_MAX_LINES
                ? current
                : { ...current, lines: [...current.lines, lineFromVariant(variant)] }
            ))}
            onChange={updateLine}
            onRemove={(variantId) => setDraft((current) => ({
              ...current,
              lines: current.lines.filter((line) => line.variantId !== variantId),
            }))}
          />
        </div>

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("costSummary")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <dl className="space-y-3">
                <SummaryRow label={t("subtotal")} detail={unitsText(totals.units)}>{fmt(totals.subtotal)}</SummaryRow>
              </dl>
              {extraField("shipping")}
              {extraField("otherCosts")}
              {extraField("tax")}
              {showErrors && (validation.extras.shipping || validation.extras.otherCosts || validation.extras.tax) ? (
                <p className="text-body text-destructive">{t("fixCosts")}</p>
              ) : null}
              <dl className="border-t pt-3">
                <SummaryRow label={t("total")} strong>{fmt(totals.total)}</SummaryRow>
              </dl>
              <p className="text-body text-muted-foreground">{t("extraCostsHelp")}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("notes")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                id="po-notes"
                aria-label={t("notes")}
                rows={4}
                maxLength={2000}
                value={draft.notes}
                aria-describedby="po-notes-help"
                onChange={(event) => update({ notes: event.target.value })}
              />
              <p id="po-notes-help" className="text-body text-muted-foreground">{t("notesHelp")}</p>
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(open) => { if (!open && !remove.isPending) setConfirmDelete(false); }}
        title={t("deleteTitle", { number: order?.displayNumber ?? "" })}
        description={t("deleteBody")}
        confirmLabel={t("deleteDraft")}
        isLoading={remove.isPending}
        onConfirm={deleteDraft}
      />
    </div>
  );
}

/** The products being ordered: add by search, then quantity and cost per item per line. */
function PurchaseOrderLinesCard({
  lines,
  addedIds,
  validation,
  showErrors,
  decimals,
  onAdd,
  onChange,
  onRemove,
}: {
  lines: PurchaseOrderDraftLine[];
  addedIds: ReadonlySet<string>;
  validation: DraftValidation;
  showErrors: boolean;
  decimals: number;
  onAdd: Parameters<typeof SkuPicker>[0]["onPick"];
  onChange: (variantId: string, patch: Partial<PurchaseOrderDraftLine>) => void;
  onRemove: (variantId: string) => void;
}) {
  const t = useMessages(purchasingMessages);
  const r = useMessages(resourceMessages);
  const { fmt } = useCurrency();
  const isMobile = useIsMobile();
  const full = lines.length >= PURCHASING_MAX_LINES;

  const problemsOf = (line: PurchaseOrderDraftLine) => {
    const problems = validation.lines.get(line.variantId);
    return {
      quantity: Boolean(problems?.quantity) && (showErrors || line.quantity !== null),
      cost: Boolean(problems?.cost) && (showErrors || line.unitCost !== null),
    };
  };

  const fields = (line: PurchaseOrderDraftLine) => {
    const name = lineName(line, t("unknownProduct"));
    const problems = problemsOf(line);
    const errorId = `po-line-${line.variantId}-error`;
    return {
      quantity: (
        <NumberInput
          integer
          className="w-24"
          value={line.quantity}
          aria-label={t("quantityFor", { name })}
          aria-invalid={problems.quantity ? true : undefined}
          aria-describedby={problems.quantity || problems.cost ? errorId : undefined}
          onValueChange={(quantity) => onChange(line.variantId, { quantity })}
        />
      ),
      cost: (
        <CostInput
          className="w-32"
          value={line.unitCost}
          placeholder="0"
          aria-label={t("costFor", { name })}
          aria-invalid={problems.cost ? true : undefined}
          aria-describedby={problems.quantity || problems.cost ? errorId : undefined}
          onValueChange={(unitCost) => onChange(line.variantId, { unitCost })}
        />
      ),
      costHint: line.currentCost !== null && line.currentCost !== line.unitCost
        ? <span className="text-body text-muted-foreground tabular-nums">{t("costNow", { amount: fmt(line.currentCost) })}</span>
        : null,
      total: (() => {
        const total = lineTotal(line.quantity, line.unitCost, decimals);
        return <span className="tabular-nums">{total === null ? "—" : fmt(total)}</span>;
      })(),
      remove: (
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("removeLine", { name })} onClick={() => onRemove(line.variantId)}>
          <X />
        </Button>
      ),
      error: problems.quantity || problems.cost ? (
        <p id={errorId} className="text-body text-destructive">
          {[problems.quantity ? t("quantityInvalid") : null, problems.cost ? t("costInvalid") : null].filter(Boolean).join(" ")}
        </p>
      ) : null,
    };
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("products")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <SkuPicker id="po-add-product" addedIds={addedIds} disabled={full} onPick={onAdd} />
        {full ? <p className="text-body text-muted-foreground">{t("maxLines", { count: PURCHASING_MAX_LINES })}</p> : null}
        {lines.length === 0 ? (
          <p className={showErrors ? "text-body text-destructive" : "text-body text-muted-foreground"}>
            {showErrors ? t("needLines") : t("noLinesYet")}
          </p>
        ) : null}
      </CardContent>
      {lines.length > 0 ? (
        isMobile ? (
          <ul className="divide-y border-t">
            {lines.map((line) => {
              const field = fields(line);
              return (
                <li key={line.variantId} className="space-y-2 px-4 py-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1"><LineProduct line={line} retired={line.retired} /></div>
                    {field.remove}
                  </div>
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="space-y-1">
                      <span className="block text-body text-muted-foreground">{t("colQuantity")}</span>
                      {field.quantity}
                    </div>
                    <div className="space-y-1">
                      <span className="block text-body text-muted-foreground">{t("colCost")}</span>
                      {field.cost}
                    </div>
                    <div className="ms-auto space-y-1 text-end">
                      <span className="block text-body text-muted-foreground">{t("colLineTotal")}</span>
                      <span className="flex h-9 items-center justify-end">{field.total}</span>
                    </div>
                  </div>
                  {field.costHint}
                  {field.error}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="border-t">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colProduct")}</TableHead>
                  <TableHead>{t("colQuantity")}</TableHead>
                  <TableHead>{t("colCost")}</TableHead>
                  <TableHead data-numeric="">{t("colLineTotal")}</TableHead>
                  <TableHead data-pin="actions"><span className="sr-only">{r("actions")}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line) => {
                  const field = fields(line);
                  return (
                    <TableRow key={line.variantId}>
                      <TableCell className="py-2">
                        <LineProduct line={line} retired={line.retired} />
                        {field.error}
                      </TableCell>
                      <TableCell className="py-2 align-top">{field.quantity}</TableCell>
                      <TableCell className="space-y-1 py-2 align-top">
                        {field.cost}
                        {field.costHint}
                      </TableCell>
                      <TableCell data-numeric="" className="py-2 align-top">
                        <span className="flex h-9 items-center justify-end">{field.total}</span>
                      </TableCell>
                      <TableCell data-pin="actions" className="py-2 align-top">{field.remove}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )
      ) : null}
    </Card>
  );
}
