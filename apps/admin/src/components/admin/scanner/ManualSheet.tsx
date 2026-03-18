import { useState, useCallback } from "react";
import {
  X,
  Check,
  Minus,
  Plus,
  Package,
  Hash,
  Ruler,
  Palette,
  Box,
  ArrowRightLeft,
  ChevronDown,
  AlertTriangle,
} from "lucide-react";
import type { ScannedProduct } from "./ScannerApp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
    product: ScannedProduct;
  }) => Promise<void>;
  onCancel: () => void;
  onHaptic: (type: "light" | "warning") => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ManualSheet({
  product,
  onSubmit,
  onCancel,
  onHaptic,
}: ManualSheetProps) {
  const [adjustment, setAdjustment] = useState(0);
  const [isAbsolute, setIsAbsolute] = useState(false);
  const [absoluteValue, setAbsoluteValue] = useState("");
  const [reason, setReason] = useState<AdjustmentReason>("Receiving");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await onSubmit({
        variantId: product.variantId,
        adjustment: isAbsolute ? Number(absoluteValue) : adjustment,
        reason,
        isAbsolute,
        product,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to adjust stock");
    } finally {
      setIsSubmitting(false);
    }
  }, [
    canSubmit,
    isLargeAdjustment,
    onHaptic,
    onSubmit,
    product,
    isAbsolute,
    absoluteValue,
    adjustment,
    reason,
  ]);

  const available = product.stock - product.reserved;

  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end">
      {/* Backdrop */}
      <div
        className="flex-1 bg-black/40"
        onClick={onCancel}
      />

      {/* Sheet */}
      <div
        className="bg-zinc-900 rounded-t-2xl border-t border-zinc-700/50 max-h-[85dvh] overflow-y-auto"
        style={{ animation: "slide-up 200ms ease-out" }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="h-1 w-10 rounded-full bg-zinc-700" />
        </div>

        <div className="px-4 pb-6 space-y-4">
          {/* Product info */}
          <div className="flex gap-3">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-800">
              {product.productImage ? (
                <img
                  src={product.productImage}
                  alt={product.productName}
                  className="h-full w-full object-cover"
                />
              ) : (
                <Package className="h-6 w-6 text-zinc-600" />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <h3 className="truncate text-base font-semibold text-white">
                {product.productName}
              </h3>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-zinc-400 mt-0.5">
                {product.size && (
                  <span className="flex items-center gap-1">
                    <Ruler className="h-3 w-3" />
                    {product.size}
                  </span>
                )}
                {product.color && (
                  <span className="flex items-center gap-1">
                    <Palette className="h-3 w-3" />
                    {product.color}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Hash className="h-3 w-3" />
                  {product.sku}
                </span>
              </div>
            </div>
          </div>

          {/* Stock info */}
          <div className="flex gap-4 rounded-lg bg-zinc-800/60 px-4 py-3">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">
                Stock
              </div>
              <div className="flex items-center gap-1">
                <Box className="h-4 w-4 text-zinc-400" />
                <span className="text-lg font-bold tabular-nums text-white">
                  {product.stock}
                </span>
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">
                Reserved
              </div>
              <span className="text-lg font-semibold tabular-nums text-zinc-300">
                {product.reserved}
              </span>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">
                Available
              </div>
              <span
                className={`text-lg font-semibold tabular-nums ${
                  available <= 0
                    ? "text-red-400"
                    : available <= 5
                      ? "text-amber-400"
                      : "text-emerald-400"
                }`}
              >
                {available}
              </span>
            </div>
          </div>

          {/* Mode toggle: relative vs absolute */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-300">
              {isAbsolute ? "Set Stock To" : "Adjust Stock"}
            </span>
            <button
              type="button"
              onClick={() => {
                setIsAbsolute(!isAbsolute);
                setAdjustment(0);
                setAbsoluteValue("");
              }}
              className="flex items-center gap-1.5 rounded-full bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 active:bg-zinc-700"
            >
              <ArrowRightLeft className="h-3 w-3" />
              {isAbsolute ? "Relative" : "Set Stock"}
            </button>
          </div>

          {!isAbsolute ? (
            <>
              {/* Quick adjust grid */}
              <div className="grid grid-cols-6 gap-1.5">
                {QUICK_BUTTONS.map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => handleQuick(amt)}
                    className={`flex h-12 items-center justify-center rounded-lg text-sm font-bold active:scale-95 transition-transform ${
                      amt < 0
                        ? "bg-red-500/15 text-red-400 active:bg-red-500/25"
                        : "bg-emerald-500/15 text-emerald-400 active:bg-emerald-500/25"
                    }`}
                  >
                    {amt < 0 ? (
                      <Minus className="mr-0.5 h-3 w-3" />
                    ) : (
                      <Plus className="mr-0.5 h-3 w-3" />
                    )}
                    {Math.abs(amt)}
                  </button>
                ))}
              </div>

              {/* Current adjustment display */}
              <div className="flex items-center justify-center gap-3 rounded-lg bg-zinc-800/60 py-3">
                <span className="text-zinc-400 text-sm">
                  {product.stock}
                </span>
                <span className="text-zinc-600">&rarr;</span>
                <span
                  className={`text-xl font-bold tabular-nums ${
                    adjustment === 0
                      ? "text-zinc-500"
                      : newStock < 0
                        ? "text-red-400"
                        : "text-emerald-400"
                  }`}
                >
                  {newStock}
                </span>
                {adjustment !== 0 && (
                  <span
                    className={`text-sm font-semibold ${
                      adjustment > 0 ? "text-emerald-400" : "text-red-400"
                    }`}
                  >
                    ({adjustment > 0 ? "+" : ""}
                    {adjustment})
                  </span>
                )}
              </div>
            </>
          ) : (
            /* Absolute mode input */
            <div className="space-y-2">
              <input
                type="number"
                value={absoluteValue}
                onChange={(e) => setAbsoluteValue(e.target.value)}
                placeholder="New stock level"
                inputMode="numeric"
                min={0}
                autoFocus
                className="h-14 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 text-center text-xl font-bold text-white placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
              />
              {absoluteValue !== "" && (
                <div className="flex items-center justify-center gap-3 rounded-lg bg-zinc-800/60 py-2 text-sm">
                  <span className="text-zinc-400">{product.stock}</span>
                  <span className="text-zinc-600">&rarr;</span>
                  <span className="font-bold text-emerald-400">
                    {Number(absoluteValue) || 0}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Reason dropdown */}
          <div className="relative">
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as AdjustmentReason)}
              className="h-12 w-full appearance-none rounded-lg border border-zinc-700 bg-zinc-800 px-4 pr-10 text-sm text-white focus:border-emerald-500 focus:outline-none"
            >
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          </div>

          {/* Large adjustment warning */}
          {isLargeAdjustment && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                Large adjustment: {adjustment > 0 ? "+" : ""}{adjustment} units
              </span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="flex h-14 flex-1 items-center justify-center gap-2 rounded-lg bg-zinc-800 text-sm font-semibold text-zinc-300 active:bg-zinc-700"
            >
              <X className="h-4 w-4" />
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="flex h-14 flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-600 text-sm font-semibold text-white disabled:opacity-40 active:bg-emerald-700"
            >
              {isSubmitting ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-300 border-t-transparent" />
                  Applying...
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  Apply
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes slide-up {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
