import { useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
import { X } from "lucide-react";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { NumberInput } from "~/components/ui/number-input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { Textarea } from "~/components/ui/textarea";
import { useIsMobile } from "~/hooks/use-mobile";
import { formatNumber, useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { resourceMessages } from "~/i18n/resource";
import {
  inventoryLocationsQueryOptions,
  productInventoryLevelsQueryOptions,
} from "~/lib/api-query-options/inventory-locations";
import {
  PURCHASING_MAX_LINES,
  useDeleteTransfer,
  useSaveTransfer,
  useTransferCommand,
  type Transfer,
} from "~/lib/api-query-options/purchasing";
import { useOperationKeys } from "./operation-key";
import { lineName } from "./purchasing-format";
import { PurchasingProblemBanner, readPurchasingProblem, type PurchasingProblem } from "./purchasing-problem";
import { TransferStatusBadge } from "./purchasing-status";
import { LineProduct, useUnitsText } from "./purchasing-ui";
import { SkuPicker } from "./SkuPicker";
import {
  transferBody,
  transferDraftFrom,
  transferFingerprint,
  transferLineFromVariant,
  validateTransferDraft,
  type TransferDraft,
  type TransferDraftLine,
} from "./transfer-draft";
import { DateInput } from "~/components/ui/date-input";
import { Field } from "~/components/ui/field";

type Busy = "save" | "ship" | null;
/** Per-line on-hand at the origin is read per product; past this many products it isn't shown. */
const ON_HAND_PRODUCT_LIMIT = 25;

/**
 * Create a transfer or edit its draft: origin and destination, details and
 * the products with their quantities (and how many the origin holds). Ship
 * saves any edits first, then takes every line out of the origin at once.
 */
export function TransferEditor({ transfer, onReload }: { transfer: Transfer | null; onReload?: () => Promise<void> }) {
  const t = useMessages(purchasingMessages);
  const r = useMessages(resourceMessages);
  const navigate = useNavigate();
  const unitsText = useUnitsText();
  const isMobile = useIsMobile();
  const keys = useOperationKeys();
  const locationsQuery = useQuery(inventoryLocationsQueryOptions());
  const activeLocations = useMemo(
    () => locationsQuery.data?.filter((location) => location.status === "active") ?? [],
    [locationsQuery.data],
  );
  const defaults = useMemo(() => {
    const origin = activeLocations.find((location) => location.isDefault) ?? activeLocations[0];
    const destination = activeLocations.find((location) => location.id !== origin?.id);
    return { originId: origin?.id ?? "", destinationId: destination?.id ?? "" };
  }, [activeLocations]);

  const [draft, setDraft] = useState<TransferDraft>(() => transferDraftFrom(transfer, defaults));
  const [savedFingerprint, setSavedFingerprint] = useState(() => (transfer ? transferFingerprint(transferDraftFrom(transfer, defaults)) : ""));
  const [revision, setRevision] = useState<number | null>(transfer?.revision ?? null);
  const [showErrors, setShowErrors] = useState(false);
  const [problem, setProblem] = useState<PurchasingProblem | null>(null);
  const [failedAction, setFailedAction] = useState<"save" | "ship">("save");
  const [busy, setBusy] = useState<Busy>(null);
  const [reloading, setReloading] = useState(false);
  const [dialog, setDialog] = useState<"ship" | "delete" | null>(null);
  // Set (and rendered) before leaving a deleted draft, so the unsaved-changes guard lets the page go.
  const [leaving, setLeaving] = useState(false);
  const save = useSaveTransfer();
  const command = useTransferCommand();
  const remove = useDeleteTransfer();

  // A new transfer starts at the default location once the locations load.
  const originId = draft.originId || defaults.originId;
  const destinationId = draft.destinationId || defaults.destinationId;
  const effective = { ...draft, originId, destinationId };
  const validation = validateTransferDraft(effective);
  const dirty = transfer ? transferFingerprint(effective) !== savedFingerprint : draft.lines.length > 0 || Boolean(draft.reference || draft.notes || draft.expectedOn);
  const origin = activeLocations.find((location) => location.id === originId) ?? (transfer ? { id: transfer.origin.id, name: transfer.origin.name } : null);
  const destination = activeLocations.find((location) => location.id === destinationId) ?? (transfer ? { id: transfer.destination.id, name: transfer.destination.name } : null);
  const totalUnits = draft.lines.reduce((sum, line) => sum + (line.quantity !== null && Number.isSafeInteger(line.quantity) && line.quantity > 0 ? line.quantity : 0), 0);
  const notEnoughLocations = locationsQuery.isSuccess && activeLocations.length < 2 && !transfer;

  // On hand at the origin, per line: one read per product (the product editor's levels).
  const productIds = useMemo(() => [...new Set(draft.lines.map((line) => line.productId))], [draft.lines]);
  const levelQueries = useQueries({
    queries: (productIds.length <= ON_HAND_PRODUCT_LIMIT ? productIds : []).map((productId) => ({
      ...productInventoryLevelsQueryOptions(productId),
      staleTime: 30_000,
    })),
  });
  // Levels list only the locations holding some: a loaded product without a row holds 0 there.
  const loadedProducts = new Set<string>();
  const onHand = new Map<string, number>();
  levelQueries.forEach((query, index) => {
    if (!query.data) return;
    loadedProducts.add(productIds[index]!);
    for (const level of query.data.levels) {
      if (level.locationId === originId) onHand.set(level.variantId, level.onHand);
    }
  });
  const onHandAtOrigin = (line: TransferDraftLine): number | null =>
    loadedProducts.has(line.productId) ? onHand.get(line.variantId) ?? 0 : null;

  const update = (patch: Partial<TransferDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const updateLine = (variantId: string, patch: Partial<TransferDraftLine>) =>
    setDraft((current) => ({ ...current, lines: current.lines.map((line) => (line.variantId === variantId ? { ...line, ...patch } : line)) }));
  const addedIds = useMemo(() => new Set(draft.lines.map((line) => line.variantId)), [draft.lines]);

  const openDetail = (id: string) => navigate({ to: "/admin/inventory/transfers/$transferId", params: { transferId: id }, replace: true });

  const saveNow = async () => {
    const sent = effective;
    const result = await save.mutateAsync({ id: transfer?.id ?? null, revision, body: transferBody(sent) });
    setSavedFingerprint(transferFingerprint(sent));
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
      toast.success(t(transfer ? "draftSaved" : "draftCreated"));
      if (!transfer) await openDetail(result.id);
    } catch (error) {
      setFailedAction("save");
      setProblem(readPurchasingProblem(error));
    } finally {
      setBusy(null);
    }
  };

  const requestShip = () => {
    if (draft.lines.length === 0) {
      setProblem({ kind: "refused", message: t("needLines") });
      return;
    }
    if (!validation.valid) {
      setShowErrors(true);
      return;
    }
    setDialog("ship");
  };

  const ship = async () => {
    if (busy) return;
    setBusy("ship");
    setProblem(null);
    let createdId: string | null = null;
    try {
      let id = transfer?.id ?? null;
      let current = revision;
      if (!transfer || dirty) {
        const result = await saveNow();
        id = result.id;
        current = result.revision;
        if (!transfer) createdId = result.id;
      }
      const operationKey = keys.keyFor(JSON.stringify({ action: "ship", id, revision: current }));
      await command.mutateAsync({ id: id!, revision: current!, operationKey, action: "ship" });
      keys.reset();
      setDialog(null);
      toast.success(t("shipped"));
      if (!transfer) await openDetail(id!);
    } catch (error) {
      setDialog(null);
      const next = readPurchasingProblem(error);
      if (createdId) {
        toast.error(next.kind === "refused" ? next.message : t("shipFailed"));
        await openDetail(createdId);
      } else {
        setFailedAction("ship");
        setProblem(next);
      }
    } finally {
      setBusy(null);
    }
  };

  const deleteDraft = () => {
    if (!transfer || revision === null) return;
    remove.mutate({ id: transfer.id, revision }, {
      onSuccess: () => {
        toast.success(t("draftDeleted"));
        flushSync(() => {
          setDialog(null);
          setLeaving(true);
        });
        void navigate({ to: "/admin/inventory/transfers" });
      },
      onError: (error) => {
        setDialog(null);
        setProblem(readPurchasingProblem(error));
      },
    });
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

  const locationOptions = activeLocations.map((location) => ({ value: location.id, label: location.name }));

  const lineFields = (line: TransferDraftLine) => {
    const name = lineName(line, t("unknownProduct"));
    const invalid = validation.invalidLines.has(line.variantId) && (showErrors || line.quantity !== null);
    const available = onHandAtOrigin(line);
    const short = available !== null && line.quantity !== null && Number.isSafeInteger(line.quantity) && line.quantity > available;
    const errorId = `transfer-line-${line.variantId}-error`;
    return {
      quantity: (
        <NumberInput
          integer
          className="w-24"
          value={line.quantity}
          aria-label={t("quantityFor", { name })}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid || short ? errorId : undefined}
          onValueChange={(quantity) => updateLine(line.variantId, { quantity })}
        />
      ),
      onHand: <span className="tabular-nums">{available === null ? "—" : formatNumber(available)}</span>,
      note: invalid ? (
        <p id={errorId} className="text-body text-destructive">{t("quantityInvalid")}</p>
      ) : short && origin ? (
        <p id={errorId} className="text-body text-warning">{t("shortAtOrigin", { count: available ?? 0, location: origin.name })}</p>
      ) : null,
      remove: (
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("removeLine", { name })}
          onClick={() => setDraft((current) => ({ ...current, lines: current.lines.filter((entry) => entry.variantId !== line.variantId) }))}
        >
          <X />
        </Button>
      ),
    };
  };

  const full = draft.lines.length >= PURCHASING_MAX_LINES;

  return (
    <div className="mx-auto max-w-5xl">
      <UnsavedChangesGuard isDirty={dirty && !leaving} isSubmitting={busy !== null || remove.isPending} />
      <PageHeader
        backTo="/admin/inventory/transfers"
        title={transfer?.displayNumber ?? t("newTransfer")}
        badge={transfer ? <TransferStatusBadge status={transfer.status} /> : null}
        actions={(
          <>
            {transfer ? (
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setDialog("delete")}>{t("deleteDraft")}</Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              loading={busy === "save"}
              disabled={busy !== null || notEnoughLocations || (transfer !== null && !dirty)}
              onClick={() => void saveDraft()}
            >
              {t("saveDraft")}
            </Button>
            <Button type="button" loading={busy === "ship"} disabled={busy !== null || notEnoughLocations} onClick={requestShip}>
              {t("ship")}
            </Button>
          </>
        )}
      />
      {notEnoughLocations ? (
        <div className="mb-4">
          <Alert variant="warning">
            <AlertDescription>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{t("needTwoLocations")}</span>
                <Button asChild variant="outline" size="sm">
                  <Link to="/admin/settings/locations">{t("addLocation")}</Link>
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      {problem ? (
        <div className="mb-4">
          <PurchasingProblemBanner
            problem={problem}
            staleText={t("transferChanged")}
            failedText={failedAction === "ship" ? t("shipFailed") : t("transferSaveFailed")}
            onReload={onReload ? () => void reload() : undefined}
            reloading={reloading}
          />
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card>
            <CardContent className="grid gap-4 pt-4 sm:grid-cols-2">
              <Field id="transfer-origin" label={t("origin")} help={t("originHelp")}>
                <SearchableSelect
                  id="transfer-origin"
                  triggerClassName="w-full"
                  value={originId}
                  placeholder={t("chooseLocation")}
                  onValueChange={(value) => {
                    if (activeLocations.some((location) => location.id === value)) update({ originId: value });
                  }}
                  options={locationOptions}
                />
              </Field>
              <Field id="transfer-destination" label={t("destination")}>
                <SearchableSelect
                  id="transfer-destination"
                  triggerClassName="w-full"
                  value={destinationId}
                  placeholder={t("chooseLocation")}
                  aria-invalid={validation.sameLocation ? true : undefined}
                  aria-describedby={validation.sameLocation ? "transfer-destination-error" : undefined}
                  onValueChange={(value) => {
                    if (activeLocations.some((location) => location.id === value)) update({ destinationId: value });
                  }}
                  options={locationOptions}
                />
                {validation.sameLocation ? (
                  <p id="transfer-destination-error" className="text-body text-destructive">{t("sameLocation")}</p>
                ) : (
                  <p className="text-body text-muted-foreground">{t("transferDestinationHelp")}</p>
                )}
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("products")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <SkuPicker
                id="transfer-add-product"
                addedIds={addedIds}
                disabled={full}
                location={origin}
                onPick={(variant) => setDraft((current) => (
                  current.lines.some((line) => line.variantId === variant.id) || current.lines.length >= PURCHASING_MAX_LINES
                    ? current
                    : { ...current, lines: [...current.lines, transferLineFromVariant(variant)] }
                ))}
              />
              {full ? <p className="text-body text-muted-foreground">{t("maxTransferLines", { count: PURCHASING_MAX_LINES })}</p> : null}
              {draft.lines.length === 0 ? (
                <p className={showErrors ? "text-body text-destructive" : "text-body text-muted-foreground"}>
                  {showErrors ? t("needLines") : t("noLinesYet")}
                </p>
              ) : null}
            </CardContent>
            {draft.lines.length > 0 ? (
              isMobile ? (
                <ul className="divide-y border-t">
                  {draft.lines.map((line) => {
                    const field = lineFields(line);
                    return (
                      <li key={line.variantId} className="space-y-2 px-4 py-3">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1"><LineProduct line={line} retired={line.retired} /></div>
                          {field.remove}
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-body text-muted-foreground">
                            {origin && onHandAtOrigin(line) !== null ? t("onHandAt", { count: onHandAtOrigin(line) ?? 0, location: origin.name }) : null}
                          </span>
                          {field.quantity}
                        </div>
                        {field.note}
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
                        <TableHead data-numeric="">{origin ? origin.name : t("colAtOrigin")}</TableHead>
                        <TableHead>{t("colQuantity")}</TableHead>
                        <TableHead data-pin="actions"><span className="sr-only">{r("actions")}</span></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {draft.lines.map((line) => {
                        const field = lineFields(line);
                        return (
                          <TableRow key={line.variantId}>
                            <TableCell className="py-2">
                              <LineProduct line={line} retired={line.retired} />
                              {field.note}
                            </TableCell>
                            <TableCell data-numeric="">{field.onHand}</TableCell>
                            <TableCell className="py-2">{field.quantity}</TableCell>
                            <TableCell data-pin="actions" className="py-2">{field.remove}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )
            ) : null}
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("shipmentDetails")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field id="transfer-expected" label={t("expectedArrival")}>
                <DateInput id="transfer-expected" value={draft.expectedOn} onValueChange={(expectedOn) => update({ expectedOn })} />
              </Field>
              <Field id="transfer-reference" label={t("reference")}>
                <Input
                  id="transfer-reference"
                  maxLength={100}
                  autoComplete="off"
                  value={draft.reference}
                  onChange={(event) => update({ reference: event.target.value })}
                />
              </Field>
              <p className="border-t pt-4 text-body text-muted-foreground tabular-nums">{unitsText(totalUnits)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("notes")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                id="transfer-notes"
                aria-label={t("notes")}
                rows={4}
                maxLength={2000}
                value={draft.notes}
                onChange={(event) => update({ notes: event.target.value })}
              />
              <p className="text-body text-muted-foreground">{t("notesHelp")}</p>
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={dialog === "ship"}
        onOpenChange={(open) => { if (!open && busy !== "ship") setDialog(null); }}
        title={t("shipTitle", { number: transfer?.displayNumber ?? t("newTransfer") })}
        description={t("shipBody", { units: unitsText(totalUnits), origin: origin?.name ?? "", destination: destination?.name ?? "" })}
        confirmLabel={t("ship")}
        variant="default"
        isLoading={busy === "ship"}
        onConfirm={() => void ship()}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(open) => { if (!open && !remove.isPending) setDialog(null); }}
        title={t("deleteTitle", { number: transfer?.displayNumber ?? "" })}
        description={t("deleteBody")}
        confirmLabel={t("deleteDraft")}
        isLoading={remove.isPending}
        onConfirm={deleteDraft}
      />
    </div>
  );
}
