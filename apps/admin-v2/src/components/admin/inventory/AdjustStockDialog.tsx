import { useRef, useState } from "react";
import { toast } from "sonner";
import { Minus, Plus } from "lucide-react";
import {
  postApiV1AdminInventoryByVariantIdAdjust,
  postApiV1AdminInventoryStockSet,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { apiData } from "~/lib/api";
import { cn } from "@scalius/shared/utils";
import type { InventoryAdjustmentReason, InventoryVariant } from "~/lib/api-query-options/inventory";
import { formatNumber, useMessages } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { resourceMessages } from "~/i18n/resource";

type AdjustmentMode = "relative" | "stocktake";

const INCREASE_REASONS = ["received", "return", "correction", "other"] as const;
const DECREASE_REASONS = ["damage", "theft", "correction", "other"] as const;

interface AdjustStockDialogProps {
  variant: InventoryVariant | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Ledger-backed stock change: explicit apply, one operation key per intent.
 * Always mounted; the parent re-keys it per opening so every opening starts clean.
 */
export function AdjustStockDialog({ variant, open, onClose, onSaved }: AdjustStockDialogProps) {
  const t = useMessages(inventoryMessages);
  const r = useMessages(resourceMessages);
  const [mode, setMode] = useState<AdjustmentMode>("relative");
  const [deltaInput, setDeltaInput] = useState("0");
  const [countInput, setCountInput] = useState("0");
  const [reason, setReason] = useState<InventoryAdjustmentReason>("received");
  const [notes, setNotes] = useState("");
  // Validation appears once the merchant has typed a quantity, not on open.
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const operationIntentRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const delta = Number(deltaInput);
  const countedStock = Number(countInput);
  const relativeInputValid = deltaInput.trim() !== "" && Number.isSafeInteger(delta) && delta !== 0;
  const stocktakeInputValid = countInput.trim() !== "" && Number.isSafeInteger(countedStock) && countedStock >= 0;
  const targetStock = variant
    ? mode === "stocktake" ? countedStock : variant.stock + delta
    : 0;
  const targetIsValid = mode === "stocktake"
    ? stocktakeInputValid
    : relativeInputValid && Number.isSafeInteger(targetStock) && targetStock >= 0;
  const effectiveDelta = variant ? targetStock - variant.stock : 0;
  const canSubmit = Boolean(
    variant &&
    !submitting &&
    targetIsValid &&
    effectiveDelta !== 0 &&
    (mode === "relative" ? relativeInputValid : stocktakeInputValid),
  );
  const newAvailable = variant ? targetStock - variant.reservedStock : 0;
  const showInvalid = touched && !targetIsValid;
  const reasonOptions: readonly InventoryAdjustmentReason[] = delta < 0 ? DECREASE_REASONS : INCREASE_REASONS;

  const operationKeyForIntent = (fingerprint: string) => {
    if (operationIntentRef.current?.fingerprint === fingerprint) {
      return operationIntentRef.current.key;
    }
    const key = `invop_${crypto.randomUUID()}`;
    operationIntentRef.current = { fingerprint, key };
    return key;
  };

  const updateRelativeDelta = (nextValue: string) => {
    setTouched(true);
    setDeltaInput(nextValue);
    const nextDelta = Number(nextValue);
    if (nextDelta < 0 && (reason === "received" || reason === "return")) {
      setReason("damage");
    } else if (nextDelta > 0 && (reason === "damage" || reason === "theft")) {
      setReason("received");
    }
  };

  const handleSubmit = async () => {
    if (!variant || !canSubmit) return;
    setSubmitting(true);
    try {
      if (mode === "stocktake") {
        const stocktakeReason = notes.trim() || "Manual stocktake";
        const operationKey = operationKeyForIntent(JSON.stringify({
          mode,
          variantId: variant.id,
          newStock: countedStock,
          reason: stocktakeReason,
        }));
        await apiData(postApiV1AdminInventoryStockSet({
          body: {
            operationKey,
            variantId: variant.id,
            newStock: countedStock,
            reason: stocktakeReason,
          },
        }));
      } else {
        const trimmedNotes = notes.trim();
        const operationKey = operationKeyForIntent(JSON.stringify({
          mode,
          variantId: variant.id,
          delta,
          reason,
          notes: trimmedNotes || null,
        }));
        await apiData(postApiV1AdminInventoryByVariantIdAdjust({
          path: { variantId: variant.id },
          body: {
            operationKey,
            delta,
            reason,
            ...(trimmedNotes ? { notes: trimmedNotes } : {}),
          },
        }));
      }
      toast.success(t("stockUpdated"));
      onSaved();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("adjustFailed"));
    } finally {
      setSubmitting(false);
    }
  };

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
                  if (value === "stocktake") setCountInput(String(variant.stock));
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
              {mode === "stocktake" ? (
                <Input
                  id="inventory-adjustment-amount"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={countInput}
                  onChange={(event) => {
                    setTouched(true);
                    setCountInput(event.target.value);
                  }}
                />
              ) : (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    aria-label={t("decrease")}
                    onClick={() => updateRelativeDelta(String((Number.isSafeInteger(delta) ? delta : 0) - 1))}
                  >
                    <Minus />
                  </Button>
                  <Input
                    id="inventory-adjustment-amount"
                    type="number"
                    step={1}
                    inputMode="numeric"
                    value={deltaInput}
                    onChange={(event) => updateRelativeDelta(event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    aria-label={t("increase")}
                    onClick={() => updateRelativeDelta(String((Number.isSafeInteger(delta) ? delta : 0) + 1))}
                  >
                    <Plus />
                  </Button>
                </div>
              )}
              {/* One reserved line, so the dialog never changes height while typing. */}
              <p
                role={showInvalid ? "alert" : undefined}
                className={cn("min-h-5 text-body", showInvalid ? "text-destructive" : "text-muted-foreground")}
              >
                {showInvalid
                  ? t("invalidQuantity")
                  : effectiveDelta !== 0
                    ? t("newStockPreview", {
                        change: `${effectiveDelta > 0 ? "+" : ""}${formatNumber(effectiveDelta)}`,
                        stock: targetStock,
                        available: newAvailable,
                      })
                    : null}
              </p>
              {targetIsValid && newAvailable < 0 ? (
                <p className="text-body text-destructive">{t("shortForOrders", { count: Math.abs(newAvailable) })}</p>
              ) : null}
            </div>

            {mode === "relative" ? (
              <div className="space-y-2">
                <Label htmlFor="inventory-adjustment-reason">{t("reason")}</Label>
                <Select value={reason} onValueChange={(value) => setReason(value as InventoryAdjustmentReason)}>
                  <SelectTrigger id="inventory-adjustment-reason" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {reasonOptions.map((value) => (
                      <SelectItem key={value} value={value}>{t(`reason_${value}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
          </form>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{r("cancel")}</Button>
          <Button type="submit" form="inventory-adjustment-form" disabled={!canSubmit} aria-busy={submitting}>
            {t("apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
