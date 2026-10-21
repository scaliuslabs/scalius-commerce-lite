import { useRef, useState } from "react";
import { toast } from "~/lib/toast";
import { Minus, Plus } from "lucide-react";
import {
  postApiV1AdminInventoryByVariantIdAdjust,
  postApiV1AdminInventoryStockSet,
  putApiV1AdminInventoryByVariantIdAlertLevel,
} from "@scalius/api-client/sdk";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NumberInput } from "~/components/ui/number-input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { apiData } from "~/lib/api";
import { readApiFieldIssues } from "~/lib/api-field-errors";
import type { InventoryAdjustmentReason, InventoryVariant } from "~/lib/api-query-options/inventory";
import type { InventoryLocation, VariantInventoryLevels } from "~/lib/api-query-options/inventory-locations";
import { formatNumber, useMessages } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { resourceMessages } from "~/i18n/resource";
import { Field } from "~/components/ui/field";

type AdjustmentMode = "relative" | "stocktake";
type ProblemField = "quantity" | "reason" | "alertLevel" | "location";

const INCREASE_REASONS: readonly InventoryAdjustmentReason[] = ["received", "return", "correction", "other"];
const DECREASE_REASONS: readonly InventoryAdjustmentReason[] = ["damage", "theft", "correction", "other"];
const ALERT_LEVEL_MAX = 1_000_000;
// API body paths → the field that shows the problem.
const FIELD_BY_PATH: Record<string, ProblemField> = {
  delta: "quantity",
  newStock: "quantity",
  reason: "reason",
  lowStockThreshold: "alertLevel",
  locationId: "location",
};

const isWhole = (value: number | null): value is number => value !== null && Number.isSafeInteger(value);

interface AdjustStockDialogProps {
  variant: InventoryVariant | null;
  /** The store-wide alert level an empty field falls back to. */
  storeLevel?: number | null;
  /**
   * The store's active locations. With more than one, stock changes at a
   * chosen location (the location select shows); with one, every number is
   * that location's and the select stays hidden.
   */
  locations?: readonly InventoryLocation[];
  /** The variant's on-hand per location; needed (and awaited) only with several locations. */
  levels?: VariantInventoryLevels;
  /** The location to start on (the inventory location filter), else the default. */
  initialLocationId?: string | null;
  open: boolean;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
  onSaved: () => void;
}

/**
 * Ledger-backed stock change plus the SKU's alert level: explicit apply, one
 * operation key per stock intent. Always mounted; the parent re-keys it per
 * opening so every opening starts clean.
 */
export function AdjustStockDialog({
  variant,
  storeLevel = null,
  locations = [],
  levels,
  initialLocationId = null,
  open,
  onClose,
  onCloseAutoFocus,
  onSaved,
}: AdjustStockDialogProps) {
  const t = useMessages(inventoryMessages);
  const r = useMessages(resourceMessages);
  const activeLocations = locations.filter((location) => location.status === "active");
  const pickLocation = activeLocations.length > 1;
  const [locationId, setLocationId] = useState<string>(() =>
    activeLocations.find((location) => location.id === initialLocationId)?.id
      ?? activeLocations.find((location) => location.isDefault)?.id
      ?? activeLocations[0]?.id
      ?? "");
  const location = activeLocations.find((candidate) => candidate.id === locationId) ?? null;
  // With several locations the dialog counts the chosen one; its level must be loaded.
  const locationOnHand = pickLocation
    ? levels?.variantId === variant?.id
      ? levels?.levels.find((level) => level.locationId === locationId)?.onHand ?? 0
      : null
    : null;
  const [mode, setMode] = useState<AdjustmentMode>("relative");
  const [delta, setDelta] = useState<number | null>(0);
  const [counted, setCounted] = useState<number | null>(variant?.stock ?? 0);
  const [reasonChoice, setReasonChoice] = useState<InventoryAdjustmentReason>("received");
  const [alertLevel, setAlertLevel] = useState<number | null>(variant?.lowStockThreshold ?? null);
  const [notes, setNotes] = useState("");
  // Validation appears once the merchant has typed, not on open.
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<ProblemField, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const operationIntentRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const fieldRefs = {
    location: useRef<HTMLButtonElement>(null),
    quantity: useRef<HTMLInputElement>(null),
    reason: useRef<HTMLButtonElement>(null),
    alertLevel: useRef<HTMLInputElement>(null),
  };

  // The on-hand being changed: the chosen location's, or the SKU's with one location.
  const stock = locationOnHand ?? variant?.stock ?? 0;
  const levelsReady = !pickLocation || locationOnHand !== null;
  const entered = mode === "stocktake" ? counted : delta;
  const targetStock = isWhole(entered) ? (mode === "stocktake" ? entered : stock + entered) : null;
  const effectiveDelta = targetStock === null ? 0 : targetStock - stock;
  // Reservations are not held at a location: availability is the SKU's.
  const newAvailable = (variant?.stock ?? 0) + effectiveDelta - (variant?.reservedStock ?? 0);
  // The reason always fits the direction: flipping the sign picks that direction's first reason.
  const reasonOptions = effectiveDelta < 0 ? DECREASE_REASONS : INCREASE_REASONS;
  const reason = reasonOptions.includes(reasonChoice) ? reasonChoice : reasonOptions[0]!;
  const alertLevelValid = alertLevel === null || (isWhole(alertLevel) && alertLevel >= 0 && alertLevel <= ALERT_LEVEL_MAX);
  const alertLevelChanged = alertLevel !== (variant?.lowStockThreshold ?? null);

  const localErrors: Partial<Record<ProblemField, string>> = {
    ...(touched && !isWhole(entered) ? { quantity: t("wholeNumber") } : {}),
    ...(targetStock !== null && targetStock < 0 ? { quantity: t("belowZero") } : {}),
    ...(!alertLevelValid ? { alertLevel: t("alertLevelInvalid") } : {}),
  };
  const errors = { ...serverErrors, ...localErrors };
  const canSubmit = Boolean(
    variant &&
    !submitting &&
    (levelsReady || effectiveDelta === 0) &&
    isWhole(entered) &&
    targetStock !== null && targetStock >= 0 &&
    alertLevelValid &&
    (effectiveDelta !== 0 || alertLevelChanged),
  );

  const clearServerError = (field: ProblemField) =>
    setServerErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));

  const operationKeyForIntent = (fingerprint: string) => {
    if (operationIntentRef.current?.fingerprint === fingerprint) {
      return operationIntentRef.current.key;
    }
    const key = `invop_${crypto.randomUUID()}`;
    operationIntentRef.current = { fingerprint, key };
    return key;
  };

  const updateDelta = (next: number | null) => {
    setTouched(true);
    clearServerError("quantity");
    setDelta(next);
  };

  const saveStock = async (current: InventoryVariant) => {
    const trimmedNotes = notes.trim();
    // A store with one location sends none: the API uses the default.
    const at = pickLocation && location ? { locationId: location.id } : {};
    if (mode === "stocktake") {
      const stocktakeReason = trimmedNotes || "Manual stocktake";
      const body = { variantId: current.id, newStock: targetStock!, reason: stocktakeReason, ...at };
      await apiData(postApiV1AdminInventoryStockSet({
        body,
        headers: { "idempotency-key": operationKeyForIntent(JSON.stringify({ mode, ...body })) },
      }));
      return;
    }
    const body = { delta: effectiveDelta, reason, ...(trimmedNotes ? { notes: trimmedNotes } : {}), ...at };
    await apiData(postApiV1AdminInventoryByVariantIdAdjust({
      path: { variantId: current.id },
      body,
      headers: { "idempotency-key": operationKeyForIntent(JSON.stringify({ mode, variantId: current.id, ...body })) },
    }));
  };

  const handleSubmit = async () => {
    if (!variant || !canSubmit) return;
    setSubmitting(true);
    setServerErrors({});
    const saved = { alertLevel: false, stock: false };
    try {
      if (alertLevelChanged) {
        await apiData(putApiV1AdminInventoryByVariantIdAlertLevel({
          path: { variantId: variant.id },
          body: { lowStockThreshold: alertLevel },
        }));
        saved.alertLevel = true;
      }
      if (effectiveDelta !== 0) {
        await saveStock(variant);
        saved.stock = true;
      }
      toast.success(t(saved.stock && saved.alertLevel ? "stockAndAlertSaved" : saved.stock ? "stockUpdated" : "alertLevelSaved"));
      onSaved();
      onClose();
    } catch (error) {
      if (saved.alertLevel) onSaved();
      // Never show server text: name the field the merchant can fix, else say nothing changed.
      const fields = (readApiFieldIssues(error) ?? []).flatMap((issue) => {
        const field = FIELD_BY_PATH[issue.path];
        return field ? [field] : [];
      });
      if (fields.length > 0) {
        const messages = {
          quantity: t("wholeNumber"),
          reason: t("chooseReason"),
          alertLevel: t("alertLevelInvalid"),
          location: t("chooseLocation"),
        };
        setServerErrors(Object.fromEntries(fields.map((field) => [field, messages[field]])));
        const first = (["location", "quantity", "reason", "alertLevel"] as const).find((field) => fields.includes(field))!;
        fieldRefs[first].current?.focus();
      } else {
        toast.error(t(saved.alertLevel ? "stockNotUpdated" : alertLevelChanged ? "alertLevelFailed" : "adjustFailed"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open && variant !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("adjustTitle")}</DialogTitle>
          <DialogDescription>
            {variant ? (
              <>
                {[variant.productName ?? t("unknownProduct"), variant.optionLabel].filter(Boolean).join(" · ")}
                {/* A SKU is a code: mono and never broken across lines (F5). */}
                {variant.sku ? <> · <code className="whitespace-nowrap">{variant.sku}</code></> : null}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {variant ? (
          <form
            id="inventory-adjustment-form"
            method="post"
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSubmit();
            }}
          >
            {pickLocation ? (
              <Field id="inventory-adjustment-location" label={t("location")} error={errors.location}>
                <SearchableSelect
                  triggerClassName="w-full"
                  triggerRef={fieldRefs.location}
                  id="inventory-adjustment-location"
                  value={locationId}
                  onValueChange={(value) => {
                    if (!activeLocations.some((candidate) => candidate.id === value)) return;
                    clearServerError("location");
                    setLocationId(value);
                    setDelta(0);
                    setCounted(levels?.levels.find((level) => level.locationId === value)?.onHand ?? 0);
                    setTouched(false);
                  }}
                  options={activeLocations.map((candidate) => ({
                    value: candidate.id,
                    label: candidate.isDefault ? t("locationDefault", { name: candidate.name }) : candidate.name,
                  }))}
                />
              </Field>
            ) : null}

            {/* Every number names its scope: with several locations the chosen
                location's on-hand sits beside the store-wide counts (orders
                are committed and sold from the SKU, not a location). */}
            <dl className={pickLocation ? "grid grid-cols-2 gap-4 sm:grid-cols-4" : "grid grid-cols-3 gap-4"}>
              {(pickLocation
                ? [
                  [t("onHandAtLocation", { location: location?.name ?? "" }), locationOnHand],
                  [t("onHandAllLocations"), variant.stock],
                  [t("committedAllLocations"), variant.reservedStock],
                  [t("availableAllLocations"), variant.available],
                ] as const
                : [
                  [t("onHand"), variant.stock],
                  [t("committed"), variant.reservedStock],
                  [t("available"), variant.available],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="space-y-1">
                  <dt className="text-body text-muted-foreground">{label}</dt>
                  <dd className="text-body font-medium tabular-nums">{value === null ? t("loading") : formatNumber(value)}</dd>
                </div>
              ))}
            </dl>

            <Field id="inventory-adjustment-mode" label={t("adjustment")} help={t(mode === "stocktake" ? "modeStocktakeHelp" : "modeRelativeHelp")}>
              <SearchableSelect
                triggerClassName="w-full"
                id="inventory-adjustment-mode"
                value={mode}
                onValueChange={(value) => {
                  setMode(value as AdjustmentMode);
                  setCounted(stock);
                  setDelta(0);
                  setTouched(false);
                }}
                options={[
                  { value: "relative", label: t("modeRelative") },
                  { value: "stocktake", label: t("modeStocktake") },
                ]}
              />
            </Field>

            <Field
              id="inventory-adjustment-amount"
              label={t(mode === "stocktake" ? "counted" : "quantity")}
              error={errors.quantity ?? (newAvailable < 0 ? t("shortForOrders", { count: Math.abs(newAvailable) }) : undefined)}
              help={effectiveDelta === 0 ? undefined : pickLocation && location
                ? t("newLocationStockPreview", {
                  change: `${effectiveDelta > 0 ? "+" : ""}${formatNumber(effectiveDelta)}`,
                  location: location.name,
                  stock: targetStock!,
                  available: newAvailable,
                })
                : t("newStockPreview", {
                  change: `${effectiveDelta > 0 ? "+" : ""}${formatNumber(effectiveDelta)}`,
                  stock: targetStock!,
                  available: newAvailable,
                })}
            >
              <div className="flex items-center gap-2">
                {mode === "relative" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    aria-label={t("decrease")}
                    onClick={() => updateDelta((isWhole(delta) ? delta : 0) - 1)}
                  >
                    <Minus />
                  </Button>
                ) : null}
                <NumberInput
                  // Each mode is its own field, so its typed text never carries over.
                  key={mode}
                  ref={fieldRefs.quantity}
                  id="inventory-adjustment-amount"
                  integer
                  value={entered}
                  onValueChange={mode === "stocktake"
                    ? (next) => {
                        setTouched(true);
                        clearServerError("quantity");
                        setCounted(next);
                      }
                    : updateDelta}
                />
                {mode === "relative" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    aria-label={t("increase")}
                    onClick={() => updateDelta((isWhole(delta) ? delta : 0) + 1)}
                  >
                    <Plus />
                  </Button>
                ) : null}
              </div>
            </Field>

            {mode === "relative" ? (
              <Field id="inventory-adjustment-reason" label={t("reason")} error={errors.reason}>
                <SearchableSelect
                  triggerClassName="w-full"
                  triggerRef={fieldRefs.reason}
                  id="inventory-adjustment-reason"
                  value={reason}
                  onValueChange={(value) => {
                    // Ignore the empty value a select can report while its options change.
                    if (!reasonOptions.includes(value as InventoryAdjustmentReason)) return;
                    clearServerError("reason");
                    setReasonChoice(value as InventoryAdjustmentReason);
                  }}
                  options={reasonOptions.map((value) => ({ value, label: t(`reason_${value}`) }))}
                />
              </Field>
            ) : null}

            <Field id="inventory-adjustment-notes" label={t("note")}>
              <Input
                id="inventory-adjustment-notes"
                maxLength={500}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>

            <div className="border-t pt-4">
              <Field
                id="inventory-alert-level"
                label={t("alertLevel")}
                error={errors.alertLevel}
                help={storeLevel ? t("alertLevelDefaultHelp", { level: storeLevel }) : t("alertLevelHelp")}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="shrink-0 text-body">{t("alertWhen")}</span>
                  <NumberInput
                    ref={fieldRefs.alertLevel}
                    id="inventory-alert-level"
                    integer
                    className="w-24"
                    value={alertLevel}
                    placeholder={storeLevel ? formatNumber(storeLevel) : undefined}
                    onValueChange={(next) => {
                      clearServerError("alertLevel");
                      setAlertLevel(next);
                    }}
                  />
                  <span className="text-body">{t("alertOrFewer")}</span>
                </div>
              </Field>
            </div>
          </form>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{r("cancel")}</Button>
          <Button type="submit" form="inventory-adjustment-form" disabled={!canSubmit} loading={submitting}>
            {t("apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
