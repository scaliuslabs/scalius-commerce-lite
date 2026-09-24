import { useRef, useState } from "react";
import { toast } from "sonner";
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
import { Label } from "~/components/ui/label";
import { NumberInput } from "~/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { apiData } from "~/lib/api";
import { readApiFieldIssues } from "~/lib/api-field-errors";
import type { InventoryAdjustmentReason, InventoryVariant } from "~/lib/api-query-options/inventory";
import { formatNumber, useMessages } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { resourceMessages } from "~/i18n/resource";

type AdjustmentMode = "relative" | "stocktake";
type Field = "quantity" | "reason" | "alertLevel";

const INCREASE_REASONS: readonly InventoryAdjustmentReason[] = ["received", "return", "correction", "other"];
const DECREASE_REASONS: readonly InventoryAdjustmentReason[] = ["damage", "theft", "correction", "other"];
const ALERT_LEVEL_MAX = 1_000_000;
// API body paths → the field that shows the problem.
const FIELD_BY_PATH: Record<string, Field> = {
  delta: "quantity",
  newStock: "quantity",
  reason: "reason",
  lowStockThreshold: "alertLevel",
};

const isWhole = (value: number | null): value is number => value !== null && Number.isSafeInteger(value);

interface AdjustStockDialogProps {
  variant: InventoryVariant | null;
  /** The store-wide alert level an empty field falls back to. */
  storeLevel?: number | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Ledger-backed stock change plus the SKU's alert level: explicit apply, one
 * operation key per stock intent. Always mounted; the parent re-keys it per
 * opening so every opening starts clean.
 */
export function AdjustStockDialog({ variant, storeLevel = null, open, onClose, onSaved }: AdjustStockDialogProps) {
  const t = useMessages(inventoryMessages);
  const r = useMessages(resourceMessages);
  const [mode, setMode] = useState<AdjustmentMode>("relative");
  const [delta, setDelta] = useState<number | null>(0);
  const [counted, setCounted] = useState<number | null>(variant?.stock ?? 0);
  const [reasonChoice, setReasonChoice] = useState<InventoryAdjustmentReason>("received");
  const [alertLevel, setAlertLevel] = useState<number | null>(variant?.lowStockThreshold ?? null);
  const [notes, setNotes] = useState("");
  // Validation appears once the merchant has typed, not on open.
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<Field, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const operationIntentRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const fieldRefs = {
    quantity: useRef<HTMLInputElement>(null),
    reason: useRef<HTMLButtonElement>(null),
    alertLevel: useRef<HTMLInputElement>(null),
  };

  const stock = variant?.stock ?? 0;
  const entered = mode === "stocktake" ? counted : delta;
  const targetStock = isWhole(entered) ? (mode === "stocktake" ? entered : stock + entered) : null;
  const effectiveDelta = targetStock === null ? 0 : targetStock - stock;
  const newAvailable = (targetStock ?? stock) - (variant?.reservedStock ?? 0);
  // The reason always fits the direction: flipping the sign picks that direction's first reason.
  const reasonOptions = effectiveDelta < 0 ? DECREASE_REASONS : INCREASE_REASONS;
  const reason = reasonOptions.includes(reasonChoice) ? reasonChoice : reasonOptions[0]!;
  const alertLevelValid = alertLevel === null || (isWhole(alertLevel) && alertLevel >= 0 && alertLevel <= ALERT_LEVEL_MAX);
  const alertLevelChanged = alertLevel !== (variant?.lowStockThreshold ?? null);

  const localErrors: Partial<Record<Field, string>> = {
    ...(touched && !isWhole(entered) ? { quantity: t("wholeNumber") } : {}),
    ...(targetStock !== null && targetStock < 0 ? { quantity: t("belowZero") } : {}),
    ...(!alertLevelValid ? { alertLevel: t("alertLevelInvalid") } : {}),
  };
  const errors = { ...serverErrors, ...localErrors };
  const canSubmit = Boolean(
    variant &&
    !submitting &&
    isWhole(entered) &&
    targetStock !== null && targetStock >= 0 &&
    alertLevelValid &&
    (effectiveDelta !== 0 || alertLevelChanged),
  );

  const clearServerError = (field: Field) =>
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
    if (mode === "stocktake") {
      const stocktakeReason = trimmedNotes || "Manual stocktake";
      const body = { variantId: current.id, newStock: targetStock!, reason: stocktakeReason };
      await apiData(postApiV1AdminInventoryStockSet({
        body: { ...body, operationKey: operationKeyForIntent(JSON.stringify({ mode, ...body })) },
      }));
      return;
    }
    const body = { delta: effectiveDelta, reason, ...(trimmedNotes ? { notes: trimmedNotes } : {}) };
    await apiData(postApiV1AdminInventoryByVariantIdAdjust({
      path: { variantId: current.id },
      body: { ...body, operationKey: operationKeyForIntent(JSON.stringify({ mode, variantId: current.id, ...body })) },
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
        const messages = { quantity: t("wholeNumber"), reason: t("chooseReason"), alertLevel: t("alertLevelInvalid") };
        setServerErrors(Object.fromEntries(fields.map((field) => [field, messages[field]])));
        const first = (["quantity", "reason", "alertLevel"] as const).find((field) => fields.includes(field))!;
        fieldRefs[first].current?.focus();
      } else {
        toast.error(t(saved.alertLevel ? "stockNotUpdated" : alertLevelChanged ? "alertLevelFailed" : "adjustFailed"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const fieldError = (field: Field, id: string) => errors[field]
    ? <p id={id} className="text-body text-destructive">{errors[field]}</p>
    : null;

  return (
    <Dialog open={open && variant !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("adjustTitle")}</DialogTitle>
          <DialogDescription>
            {variant ? [variant.productName ?? t("unknownProduct"), variant.optionLabel, variant.sku].filter(Boolean).join(" · ") : null}
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
            <dl className="grid grid-cols-3 gap-4">
              {([
                ["onHand", variant.stock],
                ["committed", variant.reservedStock],
                ["available", variant.available],
              ] as const).map(([key, value]) => (
                <div key={key} className="space-y-1">
                  <dt className="text-body text-muted-foreground">{t(key)}</dt>
                  <dd className="text-body font-medium tabular-nums">{formatNumber(value)}</dd>
                </div>
              ))}
            </dl>

            <div className="space-y-2">
              <Label htmlFor="inventory-adjustment-mode">{t("adjustment")}</Label>
              <Select
                value={mode}
                onValueChange={(value: AdjustmentMode) => {
                  setMode(value);
                  setCounted(variant.stock);
                  setDelta(0);
                  setTouched(false);
                }}
              >
                <SelectTrigger id="inventory-adjustment-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="relative">{t("modeRelative")}</SelectItem>
                  <SelectItem value="stocktake">{t("modeStocktake")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-body text-muted-foreground">
                {t(mode === "stocktake" ? "modeStocktakeHelp" : "modeRelativeHelp")}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="inventory-adjustment-amount">
                {t(mode === "stocktake" ? "counted" : "quantity")}
              </Label>
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
                  aria-invalid={errors.quantity ? true : undefined}
                  aria-describedby={errors.quantity ? "inventory-adjustment-amount-error" : undefined}
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
              {/* One reserved line, so the dialog never changes height while typing. */}
              {errors.quantity ? (
                <p id="inventory-adjustment-amount-error" role="alert" className="min-h-5 text-body text-destructive">
                  {errors.quantity}
                </p>
              ) : (
                <p className="min-h-5 text-body text-muted-foreground">
                  {effectiveDelta !== 0
                    ? t("newStockPreview", {
                        change: `${effectiveDelta > 0 ? "+" : ""}${formatNumber(effectiveDelta)}`,
                        stock: targetStock!,
                        available: newAvailable,
                      })
                    : null}
                </p>
              )}
              {!errors.quantity && newAvailable < 0 ? (
                <p className="text-body text-destructive">{t("shortForOrders", { count: Math.abs(newAvailable) })}</p>
              ) : null}
            </div>

            {mode === "relative" ? (
              <div className="space-y-2">
                <Label htmlFor="inventory-adjustment-reason">{t("reason")}</Label>
                <Select
                  value={reason}
                  onValueChange={(value) => {
                    // Ignore the empty value a select can report while its options change.
                    if (!reasonOptions.includes(value as InventoryAdjustmentReason)) return;
                    clearServerError("reason");
                    setReasonChoice(value as InventoryAdjustmentReason);
                  }}
                >
                  <SelectTrigger
                    ref={fieldRefs.reason}
                    id="inventory-adjustment-reason"
                    className="w-full"
                    aria-invalid={errors.reason ? true : undefined}
                    aria-describedby={errors.reason ? "inventory-adjustment-reason-error" : undefined}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {reasonOptions.map((value) => (
                      <SelectItem key={value} value={value}>{t(`reason_${value}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fieldError("reason", "inventory-adjustment-reason-error")}
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="inventory-adjustment-notes">{t("note")}</Label>
              <Input
                id="inventory-adjustment-notes"
                maxLength={500}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>

            <div className="space-y-2 border-t pt-4">
              <Label htmlFor="inventory-alert-level">{t("alertLevel")}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <span className="shrink-0 text-body">{t("alertWhen")}</span>
                <NumberInput
                  ref={fieldRefs.alertLevel}
                  id="inventory-alert-level"
                  integer
                  className="w-24"
                  value={alertLevel}
                  placeholder={storeLevel ? formatNumber(storeLevel) : undefined}
                  aria-invalid={errors.alertLevel ? true : undefined}
                  aria-describedby={errors.alertLevel ? "inventory-alert-level-error" : "inventory-alert-level-help"}
                  onValueChange={(next) => {
                    clearServerError("alertLevel");
                    setAlertLevel(next);
                  }}
                />
                <span className="text-body">{t("alertOrFewer")}</span>
              </div>
              {fieldError("alertLevel", "inventory-alert-level-error") ?? (
                <p id="inventory-alert-level-help" className="text-body text-muted-foreground">
                  {storeLevel ? t("alertLevelDefaultHelp", { level: storeLevel }) : t("alertLevelHelp")}
                </p>
              )}
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
