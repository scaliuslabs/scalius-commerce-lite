import { useState, useCallback } from "react";
import {
  Minus,
  Plus,
  Check,
  AlertTriangle,
  ArrowRightLeft,
  ChevronDown,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AdjustmentReason =
  | "Receiving"
  | "Damaged"
  | "Returned"
  | "Count Correction"
  | "Transfer"
  | "Other";

const REASONS: AdjustmentReason[] = [
  "Receiving",
  "Damaged",
  "Returned",
  "Count Correction",
  "Transfer",
  "Other",
];

interface StockAdjusterProps {
  variantId: string;
  currentStock: number;
  onAdjustComplete: (newStock: number) => void;
  onHaptic?: (type: "light" | "medium" | "warning") => void;
}

const QUICK_AMOUNTS = [-10, -5, -1, 1, 5, 10] as const;
const LARGE_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StockAdjuster({
  variantId,
  currentStock,
  onAdjustComplete,
  onHaptic,
}: StockAdjusterProps) {
  const [adjustment, setAdjustment] = useState(0);
  const [manualValue, setManualValue] = useState("");
  const [isSetMode, setIsSetMode] = useState(false);
  const [setStockValue, setSetStockValue] = useState("");
  const [reason, setReason] = useState<AdjustmentReason>("Receiving");
  const [customReason, setCustomReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveAdjustment = manualValue !== "" ? Number(manualValue) : adjustment;
  const newStock = isSetMode
    ? Number(setStockValue) || 0
    : currentStock + effectiveAdjustment;
  const actualReason = reason === "Other" ? customReason.trim() : reason;
  const isLargeAdjustment =
    !isSetMode && Math.abs(effectiveAdjustment) > LARGE_THRESHOLD;

  // ---- Quick button ----
  const handleQuick = useCallback(
    (amount: number) => {
      onHaptic?.("light");
      setManualValue("");
      setAdjustment((prev) => prev + amount);
    },
    [onHaptic],
  );

  // ---- Submit ----
  const submitAdjustment = useCallback(async () => {
    setError(null);
    setIsSubmitting(true);
    try {
      const url = isSetMode
        ? "/api/v1/admin/inventory/stock-set"
        : "/api/v1/admin/inventory/stock-adjust";

      const body = isSetMode
        ? { variantId, newStock: Number(setStockValue), reason: actualReason }
        : { variantId, adjustment: effectiveAdjustment, reason: actualReason };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(
          errBody?.error?.message ??
            errBody?.error ??
            `API error: ${res.status}`,
        );
      }

      const json = await res.json();
      // Handle both envelope shapes
      const data = json.data ?? json;
      const updatedStock = data.stock ?? newStock;

      onHaptic?.("medium");
      onAdjustComplete(updatedStock);

      // Reset
      setAdjustment(0);
      setManualValue("");
      setSetStockValue("");
      setShowConfirm(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to adjust stock";
      setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    isSetMode,
    variantId,
    setStockValue,
    effectiveAdjustment,
    actualReason,
    newStock,
    onAdjustComplete,
    onHaptic,
  ]);

  const handleApply = () => {
    if (isSetMode && (setStockValue === "" || isNaN(Number(setStockValue)))) return;
    if (!isSetMode && effectiveAdjustment === 0) return;
    if (!actualReason) return;

    if (isLargeAdjustment) {
      onHaptic?.("warning");
      setShowConfirm(true);
      return;
    }
    submitAdjustment();
  };

  const canSubmit =
    actualReason.length > 0 &&
    !isSubmitting &&
    (isSetMode
      ? setStockValue !== "" && !isNaN(Number(setStockValue))
      : effectiveAdjustment !== 0);

  return (
    <div className="space-y-3 rounded-xl border border-zinc-700/50 bg-zinc-900 p-4">
      {/* Mode toggle */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-300">
          {isSetMode ? "Set Stock" : "Adjust Stock"}
        </span>
        <button
          type="button"
          onClick={() => {
            setIsSetMode(!isSetMode);
            setAdjustment(0);
            setManualValue("");
            setSetStockValue("");
          }}
          className="flex items-center gap-1 rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-400 active:bg-zinc-700"
        >
          <ArrowRightLeft className="h-3 w-3" />
          {isSetMode ? "Relative" : "Absolute"}
        </button>
      </div>

      {!isSetMode ? (
        <>
          {/* Quick adjust buttons */}
          <div className="grid grid-cols-6 gap-1.5">
            {QUICK_AMOUNTS.map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => handleQuick(amt)}
                className={`flex h-12 items-center justify-center rounded-lg text-sm font-bold active:scale-95 ${
                  amt < 0
                    ? "bg-red-500/15 text-red-400 active:bg-red-500/25"
                    : "bg-emerald-500/15 text-emerald-400 active:bg-emerald-500/25"
                }`}
              >
                {amt < 0 ? <Minus className="mr-0.5 h-3 w-3" /> : <Plus className="mr-0.5 h-3 w-3" />}
                {Math.abs(amt)}
              </button>
            ))}
          </div>

          {/* Manual adjustment input */}
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={manualValue}
              onChange={(e) => {
                setManualValue(e.target.value);
                setAdjustment(0);
              }}
              placeholder="Custom amount (+/-)"
              inputMode="numeric"
              className="h-11 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-center text-sm text-white placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          {/* Preview */}
          {effectiveAdjustment !== 0 && (
            <div className="rounded-lg bg-zinc-800/60 px-3 py-2 text-center text-sm">
              <span className="text-zinc-400">Stock: </span>
              <span className="font-semibold text-zinc-200">{currentStock}</span>
              <span className="mx-2 text-zinc-600">&rarr;</span>
              <span
                className={`font-bold ${
                  newStock < 0 ? "text-red-400" : "text-emerald-400"
                }`}
              >
                {newStock}
              </span>
              <span className="ml-2 text-xs text-zinc-500">
                ({effectiveAdjustment > 0 ? "+" : ""}
                {effectiveAdjustment})
              </span>
            </div>
          )}
        </>
      ) : (
        /* Set-stock mode */
        <div className="space-y-2">
          <input
            type="number"
            value={setStockValue}
            onChange={(e) => setSetStockValue(e.target.value)}
            placeholder="New stock level"
            inputMode="numeric"
            min={0}
            className="h-12 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-center text-lg font-bold text-white placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
          {setStockValue !== "" && (
            <div className="rounded-lg bg-zinc-800/60 px-3 py-2 text-center text-sm">
              <span className="text-zinc-400">Stock: </span>
              <span className="font-semibold text-zinc-200">{currentStock}</span>
              <span className="mx-2 text-zinc-600">&rarr;</span>
              <span className="font-bold text-emerald-400">
                {Number(setStockValue) || 0}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Reason selector */}
      <div className="relative">
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value as AdjustmentReason)}
          className="h-11 w-full appearance-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 pr-8 text-sm text-white focus:border-emerald-500 focus:outline-none"
        >
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
      </div>

      {reason === "Other" && (
        <input
          type="text"
          value={customReason}
          onChange={(e) => setCustomReason(e.target.value)}
          placeholder="Enter reason..."
          className="h-11 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-sm text-white placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
        />
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Confirmation dialog */}
      {showConfirm && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-400">
            <AlertTriangle className="h-4 w-4" />
            Large adjustment: {effectiveAdjustment > 0 ? "+" : ""}
            {effectiveAdjustment} units
          </div>
          <p className="mt-1 text-xs text-amber-400/70">
            Stock will change from {currentStock} to {newStock}. Confirm?
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => setShowConfirm(false)}
              className="h-10 flex-1 rounded-lg bg-zinc-800 text-sm font-medium text-zinc-300 active:bg-zinc-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitAdjustment}
              disabled={isSubmitting}
              className="h-10 flex-1 rounded-lg bg-amber-600 text-sm font-medium text-white disabled:opacity-50 active:bg-amber-700"
            >
              {isSubmitting ? "Applying..." : "Confirm"}
            </button>
          </div>
        </div>
      )}

      {/* Apply button */}
      {!showConfirm && (
        <button
          type="button"
          onClick={handleApply}
          disabled={!canSubmit}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 text-sm font-semibold text-white disabled:opacity-40 active:bg-emerald-700"
        >
          {isSubmitting ? (
            "Applying..."
          ) : (
            <>
              <Check className="h-4 w-4" />
              Apply
            </>
          )}
        </button>
      )}
    </div>
  );
}
