import { useState, useCallback, useRef } from "react";
import {
  X,
  Check,
  Minus,
  Plus,
  Package,
  Hash,
  ArrowRightLeft,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { formatNumber, useMessages } from "~/i18n";
import { scannerMessages } from "~/i18n/scanner";
import type { ScannedProduct } from "./ScannerApp";

type AdjustmentReason =
  | "Receiving"
  | "Damaged"
  | "Returned"
  | "Correction"
  | "Transfer";

const REASONS: AdjustmentReason[] = [
  "Receiving",
  "Damaged",
  "Returned",
  "Correction",
  "Transfer",
];

const QUICK_BUTTONS = [-10, -5, -1, 1, 5, 10] as const;
const LARGE_THRESHOLD = 50;

interface ManualSheetProps {
  product: ScannedProduct;
  onSubmit: (opts: {
    variantId: string;
    adjustment: number;
    reason: string;
    isAbsolute: boolean;
    operationKey: string;
    product: ScannedProduct;
  }) => Promise<void>;
  onCancel: () => void;
  onHaptic: (type: "light" | "warning") => void;
}

export function ManualSheet({
  product,
  onSubmit,
  onCancel,
  onHaptic,
}: ManualSheetProps) {
  const t = useMessages(scannerMessages);
  const [adjustment, setAdjustment] = useState(0);
  const [isAbsolute, setIsAbsolute] = useState(false);
  const [absoluteValue, setAbsoluteValue] = useState("");
  const [reason, setReason] = useState<AdjustmentReason>("Receiving");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationIntentRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const newStock = isAbsolute
    ? Number(absoluteValue) || 0
    : product.stock + adjustment;

  const isLargeAdjustment =
    !isAbsolute && Math.abs(adjustment) > LARGE_THRESHOLD;

  const canSubmit =
    !isSubmitting &&
    (isAbsolute
      ? absoluteValue !== "" && !isNaN(Number(absoluteValue))
      : adjustment !== 0);

  const handleQuick = useCallback(
    (amount: number) => {
      onHaptic("light");
      setAdjustment((prev) => prev + amount);
    },
    [onHaptic],
  );

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    if (isLargeAdjustment) {
      onHaptic("warning");
      // Still allow — just warn with haptic
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const fingerprint = JSON.stringify({
        variantId: product.variantId,
        isAbsolute,
        adjustment: isAbsolute ? Number(absoluteValue) : adjustment,
        reason,
      });
      if (operationIntentRef.current?.fingerprint !== fingerprint) {
        operationIntentRef.current = {
          fingerprint,
          key: `invop_${crypto.randomUUID()}`,
        };
      }
      await onSubmit({
        variantId: product.variantId,
        adjustment: isAbsolute ? Number(absoluteValue) : adjustment,
        reason,
        isAbsolute,
        operationKey: operationIntentRef.current.key,
        product,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("changeFailed"));
    } finally {
      setIsSubmitting(false);
    }
    // `t` only formats the fallback error text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSubmit, isLargeAdjustment, onHaptic, onSubmit, product, isAbsolute, absoluteValue, adjustment, reason]);

  const available = product.stock - product.reserved;

  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end">
      <div className="flex-1 bg-background/60" onClick={onCancel} />

      <div className="max-h-dvh overflow-y-auto rounded-t-2xl border-t bg-card animate-in slide-in-from-bottom duration-200">
        <div className="flex justify-center pb-1 pt-3">
          <div className="h-1 w-10 rounded-full bg-muted" />
        </div>

        <div className="space-y-4 px-4 pb-6">
          <div className="flex gap-3">
            <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
              {product.productImage ? (
                <img
                  src={product.productImage}
                  alt={product.productName}
                  className="h-full w-full object-contain object-center"
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <Package className="size-6 text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-heading-md font-semibold">{product.productName}</h3>
              <div className="mt-1 flex flex-wrap gap-x-3 text-body text-muted-foreground">
                {product.optionLabel ? <span>{product.optionLabel}</span> : null}
                <span className="flex items-center gap-1 font-mono">
                  <Hash className="size-3" />
                  {product.sku}
                </span>
              </div>
            </div>
          </div>

          <dl className="grid grid-cols-3 gap-2 rounded-lg bg-muted px-4 py-3">
            {([
              ["onHand", product.stock],
              ["committed", product.reserved],
              ["available", available],
            ] as const).map(([key, value]) => (
              <div key={key} className="space-y-1">
                <dt className="text-body text-muted-foreground">{t(key)}</dt>
                <dd className={cn("text-body font-medium tabular-nums", key === "available" && available <= 0 && "text-destructive")}>
                  {formatNumber(value)}
                </dd>
              </div>
            ))}
          </dl>

          <div className="flex items-center justify-between">
            <span className="text-body font-medium">{t(isAbsolute ? "setStock" : "changeStock")}</span>
            <button
              type="button"
              onClick={() => {
                setIsAbsolute(!isAbsolute);
                setAdjustment(0);
                setAbsoluteValue("");
              }}
              className="flex h-11 items-center gap-2 rounded-full bg-muted px-4 text-body text-muted-foreground active:bg-accent"
            >
              <ArrowRightLeft className="size-4" />
              {t(isAbsolute ? "addOrRemove" : "exactCount")}
            </button>
          </div>

          {!isAbsolute ? (
            <>
              <div className="grid grid-cols-6 gap-2">
                {QUICK_BUTTONS.map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => handleQuick(amt)}
                    className={cn(
                      "flex h-12 items-center justify-center rounded-lg text-body font-medium transition-transform active:scale-95",
                      amt < 0 ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-foreground",
                    )}
                  >
                    {amt < 0 ? <Minus className="size-3" /> : <Plus className="size-3" />}
                    {formatNumber(Math.abs(amt))}
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-center gap-3 rounded-lg bg-muted py-3">
                <span className="text-body text-muted-foreground">{formatNumber(product.stock)}</span>
                <span className="text-muted-foreground">→</span>
                <span className={cn("text-body font-medium tabular-nums", adjustment === 0 && "text-muted-foreground", newStock < 0 && "text-destructive")}>
                  {formatNumber(newStock)}
                </span>
                {adjustment !== 0 ? (
                  <span className={cn("text-body font-semibold", adjustment < 0 && "text-destructive")}>
                    ({adjustment > 0 ? "+" : ""}{formatNumber(adjustment)})
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <input
                type="number"
                value={absoluteValue}
                onChange={(e) => setAbsoluteValue(e.target.value)}
                placeholder={t("newStock")}
                aria-label={t("newStock")}
                inputMode="numeric"
                min={0}
                autoFocus
                className="h-14 w-full rounded-lg border bg-muted px-4 text-center text-body font-medium placeholder:text-muted-foreground focus:border-ring focus:outline-none"
              />
              {absoluteValue !== "" ? (
                <div className="flex items-center justify-center gap-3 rounded-lg bg-muted py-2 text-body">
                  <span className="text-muted-foreground">{formatNumber(product.stock)}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="font-medium">{formatNumber(Number(absoluteValue) || 0)}</span>
                </div>
              ) : null}
            </div>
          )}

          <SearchableSelect
            triggerClassName="w-full"
            value={reason}
            onValueChange={(value) => setReason(value as AdjustmentReason)}
            ariaLabel={t("reason")}
            options={REASONS.map((value) => ({ value, label: t(`reason_${value}`) }))}
          />

          {isLargeAdjustment ? (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-body text-destructive">
              <span className="flex h-5 shrink-0 items-center">
                <AlertTriangle className="size-4" />
              </span>
              <span>{t("largeChange", { change: `${adjustment > 0 ? "+" : ""}${formatNumber(adjustment)}` })}</span>
            </div>
          ) : null}

          {error ? (
            <div role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-body text-destructive">{error}</div>
          ) : null}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="flex h-14 flex-1 items-center justify-center gap-2 rounded-lg bg-muted text-body font-semibold active:bg-accent"
            >
              <X className="size-4" />
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="flex h-14 flex-1 items-center justify-center gap-2 rounded-lg bg-primary text-body font-semibold text-primary-foreground active:opacity-80 disabled:opacity-40"
            >
              {isSubmitting ? (
                <>
                  <span className="size-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                  {t("saving")}
                </>
              ) : (
                <>
                  <Check className="size-4" />
                  {t("apply")}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
